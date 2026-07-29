import { listChannelCapabilities } from "./channel-capabilities.mjs";
import { listChannelGuides } from "./channel-guides.mjs";
import { usesNotificationDirectoryRpc } from "./notification-directory.mjs";

function safeAccountUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function getProductRuntime(env) {
  const guides = await listChannelGuides(env, { includeDisabled: true });
  const channels = listChannelCapabilities(env, guides);
  const directoryMode = usesNotificationDirectoryRpc(env) ? "rpc" : "local";
  const wechatSendMode = String(env.WECHAT_SEND_MODE || "template").trim().toLowerCase();
  return {
    directoryMode,
    serviceCredentials: {
      source: directoryMode === "rpc" ? "cf-auth" : "cf-notify",
      localManagementEnabled: directoryMode !== "rpc"
    },
    messaging: {
      wechatSendMode,
      templateMappingEnabled: wechatSendMode === "template"
    },
    canonicalApiPath: "/api/v1/notifications",
    cfAuthAccountUrl: safeAccountUrl(env.CF_AUTH_ACCOUNT_URL),
    channels
  };
}

async function checkDatabase(env) {
  if (!env.db) return { status: "down", detail: "D1 binding is missing" };
  try {
    const result = await env.db.prepare("SELECT 1 AS ok").first();
    return result?.ok === 1 ? { status: "ok" } : { status: "down", detail: "D1 probe failed" };
  } catch (error) {
    return { status: "down", detail: String(error?.message || error).slice(0, 160) };
  }
}

async function checkKv(env) {
  if (!env.kv) return { status: "down", detail: "KV binding is missing" };
  try {
    await env.kv.get("healthcheck:readiness");
    return { status: "ok" };
  } catch (error) {
    return { status: "down", detail: String(error?.message || error).slice(0, 160) };
  }
}

function localHttpAllowed(url) {
  return url.protocol === "http:"
    && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
}

async function checkEgress(env) {
  const base = String(env.EGRESS_BASE_URL || "").trim();
  if (!base) return { status: "down", detail: "EGRESS_BASE_URL is missing" };
  if (!String(env.EGRESS_SHARED_SECRET || "").trim()) {
    return { status: "down", detail: "EGRESS_SHARED_SECRET is missing" };
  }
  let url;
  try {
    url = new URL("/health", base);
  } catch {
    return { status: "down", detail: "EGRESS_BASE_URL is invalid" };
  }
  if (url.protocol !== "https:" && !localHttpAllowed(url)) {
    return { status: "down", detail: "egress health endpoint must use HTTPS" };
  }
  const configuredTimeout = Number(env.EGRESS_HEALTH_TIMEOUT_MS || 2500);
  const timeoutMs = Number.isFinite(configuredTimeout)
    ? Math.max(500, Math.min(5000, configuredTimeout))
    : 2500;
  const fetcher = typeof env.egressFetch === "function" ? env.egressFetch : fetch;
  try {
    const response = await fetcher(url.toString(), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (response.body) await response.body.cancel().catch(() => {});
    return response.ok
      ? { status: "ok", detail: `HTTP ${response.status}` }
      : { status: "down", detail: `HTTP ${response.status}` };
  } catch (error) {
    return { status: "down", detail: String(error?.message || error).slice(0, 160) };
  }
}

export async function getAdminReadiness(env) {
  const [runtime, database, kv, egress] = await Promise.all([
    getProductRuntime(env),
    checkDatabase(env),
    checkKv(env),
    checkEgress(env)
  ]);
  const checks = {
    database,
    kv,
    notificationDirectory: {
      status: runtime.directoryMode === "rpc"
        ? (env.authService ? "ok" : "down")
        : database.status,
      detail: runtime.directoryMode === "rpc" ? "cf-auth Service Binding" : "local directory"
    },
    dispatchQueue: {
      status: env.dispatchQueue && typeof env.dispatchQueue.send === "function" ? "configured" : "down"
    },
    deliveryQueue: {
      status: env.deliveryQueue && typeof env.deliveryQueue.send === "function" ? "configured" : "down"
    },
    egress
  };
  const degraded = Object.values(checks).some((item) => item.status === "down");
  return {
    ok: !degraded,
    status: degraded ? "degraded" : "healthy",
    checkedAt: new Date().toISOString(),
    checks,
    runtime
  };
}
