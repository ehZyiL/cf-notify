#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/sync-production-secrets.sh [--check|--apply]

  --check  Verify the canonical cloudclone environment, active Worker bindings,
           provider credential inventory, callback signature, and fixed-egress
           authentication. This is the default.
  --apply  Deploy the Worker with secrets read from cloudclone, restart the egress
           service, then run the same checks.

Production secrets are read over SSH from /etc/cf-notify-egress.env. Secret values
are held only in a mode-700 temporary directory and are never printed.
EOF
}

mode="check"
case "${1:-}" in
  ""|--check) mode="check" ;;
  --apply) mode="apply" ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
wrangler_config="${CF_NOTIFY_WRANGLER_CONFIG:-$project_dir/wrangler.toml}"
egress_ssh_target="${CF_NOTIFY_EGRESS_SSH_TARGET:-root@103.7.138.103}"
egress_ssh_key="${CF_NOTIFY_EGRESS_SSH_KEY:-/home/ehzyil/.ssh/cloudclone2h2g}"
egress_env_file="${CF_NOTIFY_EGRESS_ENV_FILE:-/etc/cf-notify-egress.env}"
callback_url="${CF_NOTIFY_CALLBACK_URL:-https://cf-notify.ehzyil.cc.cd/wechat/callback}"

for required_command in awk curl jq npx openssl scp sha1sum ssh; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$required_command" >&2
    exit 3
  fi
done

if [ ! -r "$wrangler_config" ]; then
  printf 'Wrangler config is not readable: %s\n' "$wrangler_config" >&2
  exit 3
fi
if [ ! -r "$egress_ssh_key" ]; then
  printf 'SSH key is not readable: %s\n' "$egress_ssh_key" >&2
  exit 3
fi

ssh_options=(
  -o BatchMode=yes
  -o ConnectTimeout=10
  -i "$egress_ssh_key"
)

sync_dir=$(mktemp -d /tmp/cf-notify-production-sync.XXXXXX)
chmod 700 "$sync_dir"
remote_app_id_file="$sync_dir/wechat-app-id"
egress_secret_file="$sync_dir/egress-shared-secret"
wechat_token_file="$sync_dir/wechat-token"
wechat_aes_key_file="$sync_dir/wechat-aes-key"
wecom_corp_id_file="$sync_dir/wecom-corp-id"
wecom_agent_id_file="$sync_dir/wecom-agent-id"
wecom_app_secret_file="$sync_dir/wecom-app-secret"
worker_secrets_file="$sync_dir/worker-secrets.env"
callback_body_file="$sync_dir/callback-body"
egress_body_file="$sync_dir/egress-body"
egress_header_file="$sync_dir/egress-header"
deployment_file="$sync_dir/deployment.json"
version_file="$sync_dir/version.json"
secret_list_file="$sync_dir/secret-list.json"

cleanup() {
  for cleanup_file in \
    "$remote_app_id_file" \
    "$egress_secret_file" \
    "$wechat_token_file" \
    "$wechat_aes_key_file" \
    "$wecom_corp_id_file" \
    "$wecom_agent_id_file" \
    "$wecom_app_secret_file" \
    "$worker_secrets_file" \
    "$callback_body_file" \
    "$egress_body_file" \
    "$egress_header_file" \
    "$deployment_file" \
    "$version_file" \
    "$secret_list_file"; do
    if [ -f "$cleanup_file" ]; then
      unlink -- "$cleanup_file"
    fi
  done
  rmdir -- "$sync_dir" 2>/dev/null || true
}
trap cleanup EXIT
umask 077

fetch_remote_value() {
  local key_name=$1
  local output_file=$2
  local allow_empty=${3:-no}

  if ! ssh "${ssh_options[@]}" "$egress_ssh_target" bash -s -- \
    "$egress_env_file" "$key_name" "$allow_empty" <<'REMOTE' > "$output_file"
set -euo pipefail
env_file=$1
wanted_key=$2
allow_empty=$3
test -r "$env_file"
awk -v wanted_key="$wanted_key" -v allow_empty="$allow_empty" '
BEGIN { found = 0 }
$1 == wanted_key {
  value = $0
  sub(/^[^=]*=/, "", value)
  found = 1
  if (allow_empty != "yes" && length(value) == 0) exit 43
  printf "%s", value
  exit
}
END { if (!found) exit 42 }
' FS='=' "$env_file"
REMOTE
  then
    return 1
  fi
  chmod 600 "$output_file"
}

remote_permissions=$(ssh "${ssh_options[@]}" "$egress_ssh_target" \
  "stat -c '%U:%G:%a' '$egress_env_file'")
if [ "$remote_permissions" != "root:root:600" ]; then
  printf 'Canonical environment must be root:root:600; got %s\n' "$remote_permissions" >&2
  exit 4
fi

if ! ssh "${ssh_options[@]}" "$egress_ssh_target" bash -s -- "$egress_env_file" <<'REMOTE'
set -euo pipefail
env_file=$1
wechat_app_secret=$(awk -F= '$1 == "WECHAT_APP_SECRET" { sub(/^[^=]*=/, ""); print; exit }' "$env_file")
wecom_corp_id=$(awk -F= '$1 == "WECOM_CORP_ID" { sub(/^[^=]*=/, ""); print; exit }' "$env_file")
wecom_agent_id=$(awk -F= '$1 == "WECOM_AGENT_ID" { sub(/^[^=]*=/, ""); print; exit }' "$env_file")
wecom_app_secret=$(awk -F= '$1 == "WECOM_APP_SECRET" { sub(/^[^=]*=/, ""); print; exit }' "$env_file")
if ! [[ "$wechat_app_secret" =~ ^[0-9A-Fa-f]{32}$ ]]; then
  echo 'remote_wechat_app_secret=invalid' >&2
  exit 44
fi
if ! [[ "$wecom_corp_id" =~ ^ww[0-9A-Za-z]{16}$ ]]; then
  echo 'remote_wecom_corp_id=invalid' >&2
  exit 44
fi
if ! [[ "$wecom_agent_id" =~ ^[0-9]+$ ]]; then
  echo 'remote_wecom_agent_id=invalid' >&2
  exit 44
fi
if ! [[ "$wecom_app_secret" =~ ^[0-9A-Za-z_-]{43}$ ]]; then
  echo 'remote_wecom_app_secret=invalid' >&2
  exit 44
fi
echo 'remote_provider_credentials=present'
REMOTE
then
  exit 4
fi

fetch_remote_value WECHAT_APP_ID "$remote_app_id_file"
fetch_remote_value EGRESS_SHARED_SECRET "$egress_secret_file"
fetch_remote_value WECHAT_TOKEN "$wechat_token_file"
if ! fetch_remote_value WECHAT_AES_KEY "$wechat_aes_key_file" yes; then
  : > "$wechat_aes_key_file"
fi
fetch_remote_value WECOM_CORP_ID "$wecom_corp_id_file"
fetch_remote_value WECOM_AGENT_ID "$wecom_agent_id_file"
fetch_remote_value WECOM_APP_SECRET "$wecom_app_secret_file"

remote_app_id=$(sed -n '1p' "$remote_app_id_file")
local_app_id=$(awk -F'"' '/^[[:space:]]*WECHAT_APP_ID[[:space:]]*=/{print $2; exit}' "$wrangler_config")
remote_wecom_corp_id=$(sed -n '1p' "$wecom_corp_id_file")
local_wecom_corp_id=$(awk -F'"' '/^[[:space:]]*WECOM_CORP_ID[[:space:]]*=/{print $2; exit}' "$wrangler_config")
if ! [[ "$remote_app_id" =~ ^wx[0-9A-Za-z]{16}$ ]]; then
  echo 'Canonical WECHAT_APP_ID has an invalid format.' >&2
  exit 4
fi
if [ "$local_app_id" != "$remote_app_id" ]; then
  echo 'WECHAT_APP_ID drift: wrangler.toml does not match cloudclone.' >&2
  exit 4
fi
if [ "$local_wecom_corp_id" != "$remote_wecom_corp_id" ]; then
  echo 'WECOM_CORP_ID drift: wrangler.toml does not match cloudclone.' >&2
  exit 4
fi
if [ "$(wc -c < "$egress_secret_file")" -lt 32 ]; then
  echo 'Canonical EGRESS_SHARED_SECRET is too short.' >&2
  exit 4
fi
wechat_token_length=$(wc -c < "$wechat_token_file")
if [ "$wechat_token_length" -lt 3 ] || [ "$wechat_token_length" -gt 32 ]; then
  echo 'Canonical WECHAT_TOKEN must be 3-32 characters.' >&2
  exit 4
fi
if [ -s "$wechat_aes_key_file" ] && [ "$(wc -c < "$wechat_aes_key_file")" -ne 43 ]; then
  echo 'Canonical WECHAT_AES_KEY must be empty or 43 characters.' >&2
  exit 4
fi

write_worker_secret() {
  local key_name=$1
  local value_file=$2
  awk -v key_name="$key_name" -v value_file="$value_file" '
BEGIN {
  if ((getline value < value_file) < 1 || length(value) == 0) exit 45
  close(value_file)
  printf "%s=%s\n", key_name, value
}
' >> "$worker_secrets_file"
}

: > "$worker_secrets_file"
write_worker_secret EGRESS_SHARED_SECRET "$egress_secret_file"
write_worker_secret WECHAT_TOKEN "$wechat_token_file"
if [ -s "$wechat_aes_key_file" ]; then
  write_worker_secret WECHAT_AES_KEY "$wechat_aes_key_file"
fi

if [ "$mode" = "apply" ]; then
  (
    cd "$project_dir"
    npx wrangler deploy --dry-run --config "$wrangler_config" --secrets-file "$worker_secrets_file"
    npx wrangler deploy \
      --config "$wrangler_config" \
      --secrets-file "$worker_secrets_file" \
      --strict \
      --message "Synchronize production notification secrets"
  )
  ssh "${ssh_options[@]}" "$egress_ssh_target" \
    'systemctl restart cf-notify-egress.service && systemctl is-active cf-notify-egress.service'
fi

(
  cd "$project_dir"
  npx wrangler secret list --config "$wrangler_config" > "$secret_list_file"
  npx wrangler deployments status --config "$wrangler_config" --json > "$deployment_file"
)

for required_secret in EGRESS_SHARED_SECRET WECHAT_TOKEN; do
  if ! jq -e --arg name "$required_secret" \
    '.[] | select(.name == $name and .type == "secret_text")' \
    "$secret_list_file" >/dev/null; then
    printf 'Active Worker secret is missing or has the wrong type: %s\n' "$required_secret" >&2
    exit 5
  fi
done
if jq -e '.[] | select(.name == "WECHAT_APP_SECRET")' "$secret_list_file" >/dev/null; then
  echo 'WECHAT_APP_SECRET must never be present in the Worker.' >&2
  exit 5
fi
if [ -s "$wechat_aes_key_file" ]; then
  if ! jq -e '.[] | select(.name == "WECHAT_AES_KEY" and .type == "secret_text")' \
    "$secret_list_file" >/dev/null; then
    echo 'WECHAT_AES_KEY is configured canonically but missing from the Worker.' >&2
    exit 5
  fi
fi

active_version=$(jq -r '.versions[] | select(.percentage == 100) | .version_id' "$deployment_file")
if [ -z "$active_version" ] || [ "$active_version" = "null" ]; then
  echo 'Could not resolve the 100% active Worker version.' >&2
  exit 5
fi
(
  cd "$project_dir"
  npx wrangler versions view "$active_version" --config "$wrangler_config" --json > "$version_file"
)
active_app_id=$(jq -r '.resources.bindings[] | select(.name == "WECHAT_APP_ID") | .text' "$version_file")
active_wecom_corp_id=$(jq -r '.resources.bindings[] | select(.name == "WECOM_CORP_ID") | .text' "$version_file")
if [ "$active_app_id" != "$remote_app_id" ]; then
  echo 'Active Worker WECHAT_APP_ID does not match cloudclone.' >&2
  exit 5
fi
if [ "$active_wecom_corp_id" != "$remote_wecom_corp_id" ]; then
  echo 'Active Worker WECOM_CORP_ID does not match cloudclone.' >&2
  exit 5
fi
if jq -e '.resources.bindings[] | select(.name == "WECHAT_APP_SECRET")' "$version_file" >/dev/null; then
  echo 'Active Worker still contains WECHAT_APP_SECRET.' >&2
  exit 5
fi

callback_timestamp=$(date +%s)
callback_nonce="cfnotify$(openssl rand -hex 8)"
callback_echo="cf-notify-callback-ok"
callback_token=$(sed -n '1p' "$wechat_token_file")
callback_signature=$(
  printf '%s\n%s\n%s\n' "$callback_token" "$callback_timestamp" "$callback_nonce" \
    | LC_ALL=C sort | tr -d '\n' | sha1sum | awk '{print $1}'
)
unset callback_token
callback_http=$(curl --silent --show-error --get \
  --output "$callback_body_file" \
  --write-out '%{http_code}' \
  "$callback_url" \
  --data-urlencode "signature=$callback_signature" \
  --data-urlencode "timestamp=$callback_timestamp" \
  --data-urlencode "nonce=$callback_nonce" \
  --data-urlencode "echostr=$callback_echo")
if [ "$callback_http" != "200" ] || [ "$(sed -n '1p' "$callback_body_file")" != "$callback_echo" ]; then
  printf 'Signed callback probe failed with HTTP %s.\n' "$callback_http" >&2
  exit 6
fi

egress_base_url=$(awk -F'"' '/^[[:space:]]*EGRESS_BASE_URL[[:space:]]*=/{print $2; exit}' "$wrangler_config")
if ! [[ "$egress_base_url" =~ ^https:// ]]; then
  echo 'EGRESS_BASE_URL must be HTTPS in production.' >&2
  exit 6
fi
awk -v value_file="$egress_secret_file" '
BEGIN {
  getline value < value_file
  close(value_file)
  printf "X-Egress-Key: %s", value
}
' > "$egress_header_file"
egress_http=$(curl --silent --show-error \
  --request POST \
  --output "$egress_body_file" \
  --write-out '%{http_code}' \
  "$egress_base_url/wechat/custom/send" \
  --header @"$egress_header_file" \
  --header 'Content-Type: application/json' \
  --data '{}')
if [ "$egress_http" != "400" ] || ! grep -q 'openid and text required' "$egress_body_file"; then
  printf 'Fixed-egress authentication probe failed with HTTP %s.\n' "$egress_http" >&2
  exit 6
fi

wecom_egress_http=$(curl --silent --show-error \
  --request POST \
  --output "$egress_body_file" \
  --write-out '%{http_code}' \
  "$egress_base_url/wecom/app/send" \
  --header @"$egress_header_file" \
  --header 'Content-Type: application/json' \
  --data '{}')
if [ "$wecom_egress_http" != "400" ] || ! grep -q 'one WeCom userId is required' "$egress_body_file"; then
  printf 'WeCom fixed-egress authentication probe failed with HTTP %s.\n' "$wecom_egress_http" >&2
  exit 6
fi

printf 'mode=%s\n' "$mode"
printf 'canonical_env_permissions=%s\n' "$remote_permissions"
printf 'worker_version=%s\n' "$active_version"
printf 'wechat_app_id_sync=passed\n'
printf 'wecom_corp_id_sync=passed\n'
printf 'provider_credential_inventory=passed\n'
printf 'wechat_callback_signature=passed\n'
printf 'egress_authentication=passed\n'
printf 'wecom_egress_authentication=passed\n'
printf 'production_secret_sync=passed\n'
