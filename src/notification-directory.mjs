import { requireServiceClient } from "./auth-service.mjs";
import { getVerifiedBinding } from "./bindings.mjs";
import { bearerToken, HttpError } from "./http.mjs";
import { resolveSubscribedChannels } from "./subscriptions.mjs";

const CHANNEL_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

export function usesNotificationDirectoryRpc(env) {
  return String(env.NOTIFICATION_DIRECTORY_MODE || "local").toLowerCase() === "rpc";
}

function rpcMethod(env, name) {
  const service = env.authService;
  const method = service?.[name];
  if (typeof method !== "function") {
    throw new HttpError(503, "cf-auth notification directory is unavailable");
  }
  return (...args) => service[name](...args);
}

function normalizeScopes(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[\s,]+/);
  return [...new Set(values.map((scope) => String(scope).trim()).filter(Boolean))];
}

function unavailableRecipient() {
  return new HttpError(404, "recipient_not_available");
}

async function callDirectory(env, name, input) {
  try {
    return await rpcMethod(env, name)(input);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.error(JSON.stringify({
      event: "notification_directory_rpc_failed",
      method: name,
      errorType: String(error?.name || "Error").slice(0, 100),
      errorMessage: String(error?.message || "RPC call failed").slice(0, 300)
    }));
    throw new HttpError(503, "cf-auth notification directory is unavailable");
  }
}

export async function requireServiceIdentity(env, request, options = {}) {
  if (!usesNotificationDirectoryRpc(env)) {
    return requireServiceClient(env.db, request, options);
  }

  const rawKey = bearerToken(request);
  if (!rawKey) throw new HttpError(401, "service authentication required");
  const result = await callDirectory(env, "verifyServiceApiKey", rawKey);
  if (!result || result.valid === false || result.active === false || !result.serviceId) {
    throw new HttpError(401, "invalid service credentials");
  }
  const scopes = normalizeScopes(result.scopes);
  if (options.scope && !scopes.includes(options.scope)) {
    throw new HttpError(403, `missing required scope: ${options.scope}`);
  }
  const clientId = String(result.keyId || result.clientId || "cf-auth-api-key").slice(0, 128);
  return {
    clientId,
    serviceId: String(result.serviceId).slice(0, 128),
    name: String(result.name || clientId).slice(0, 200),
    scopes
  };
}

function publicChannel(value) {
  const channel = String(value?.channel || "");
  if (!CHANNEL_PATTERN.test(channel)) return null;
  return {
    channel,
    available: Boolean(value.available),
    enabled: Boolean(value.enabled),
    ...(value.maskedTarget ? { maskedTarget: String(value.maskedTarget).slice(0, 200) } : {}),
    ...(value.reason ? { reason: String(value.reason).slice(0, 100) } : {})
  };
}

function publicSettings(result, input) {
  if (!result || result.ok === false || result.error === "recipient_not_available") {
    throw unavailableRecipient();
  }
  if (String(result.serviceId || "") !== input.serviceId || String(result.userId || "") !== input.userId) {
    throw unavailableRecipient();
  }
  const channels = (Array.isArray(result.channels) ? result.channels : [])
    .map(publicChannel)
    .filter(Boolean);
  const quiet = result.quietHours && typeof result.quietHours === "object"
    ? {
        timezone: String(result.quietHours.timezone || "UTC").slice(0, 100),
        start: result.quietHours.start == null ? null : String(result.quietHours.start).slice(0, 5),
        end: result.quietHours.end == null ? null : String(result.quietHours.end).slice(0, 5)
      }
    : null;
  return {
    userId: input.userId,
    serviceId: input.serviceId,
    enabled: Boolean(result.enabled),
    eventType: String(result.eventType || input.eventType || "").slice(0, 128),
    channels,
    ...(quiet ? { quietHours: quiet } : {}),
    ...(result.version != null ? { version: String(result.version).slice(0, 200) } : {})
  };
}

export async function getEffectiveNotificationSettings(env, input) {
  if (!usesNotificationDirectoryRpc(env)) {
    throw new HttpError(503, "effective settings require cf-auth notification directory RPC");
  }
  const normalized = {
    serviceId: String(input.serviceId || ""),
    userId: String(input.userId || ""),
    eventType: String(input.eventType || "")
  };
  const result = await callDirectory(env, "getEffectiveNotificationSettings", normalized);
  return publicSettings(result, normalized);
}

export async function authorizeNotificationEvent(env, input) {
  if (!usesNotificationDirectoryRpc(env)) return null;
  const normalized = {
    serviceId: String(input.serviceId || ""),
    userId: String(input.userId || ""),
    eventType: String(input.eventType || ""),
    data: input.data
  };
  const result = await callDirectory(env, "authorizeNotificationEvent", normalized);
  if (result?.error === "invalid_payload") {
    throw new HttpError(400, String(result.message || "notification payload is invalid").slice(0, 300));
  }
  return publicSettings(result, normalized);
}

function normalizeRpcTargets(result) {
  if (!result || result.ok === false || result.error === "recipient_not_available") {
    return {
      decisionVersion: null,
      targets: [],
      deferUntil: null,
      skipReason: "recipient_not_available"
    };
  }
  const targets = [];
  const seen = new Set();
  for (const value of Array.isArray(result.targets) ? result.targets : []) {
    const channel = String(value?.channel || "");
    const bindingId = String(value?.bindingId || "");
    const address = String(value?.address || "");
    if (!CHANNEL_PATTERN.test(channel) || !bindingId || !address || address.length > 16 * 1024) continue;
    const key = `${channel}:${bindingId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({
      channel,
      bindingId: bindingId.slice(0, 200),
      address,
      ...(value.maskedTarget ? { maskedTarget: String(value.maskedTarget).slice(0, 200) } : {}),
      ...(value.targetFingerprint ? {
        targetFingerprint: String(value.targetFingerprint).slice(0, 200)
      } : {})
    });
  }
  return {
    decisionVersion: result.decisionVersion == null
      ? null
      : String(result.decisionVersion).slice(0, 200),
    targets,
    deferUntil: result.deferUntil || null,
    skipReason: result.skipReason ? String(result.skipReason).slice(0, 100) : null
  };
}

export async function resolveNotificationTargets(env, input) {
  if (usesNotificationDirectoryRpc(env)) {
    const result = await callDirectory(env, "resolveNotificationTargets", {
      serviceId: String(input.serviceId || ""),
      userId: String(input.userId || ""),
      eventType: String(input.eventType || "")
    });
    return normalizeRpcTargets(result);
  }

  const channels = await resolveSubscribedChannels(env.db, {
    userId: input.userId,
    serviceId: input.serviceId,
    eventType: input.eventType,
    channels: input.channels || ["wechat_oa"],
    defaultOpen: env.SUBSCRIPTIONS_DEFAULT_OPEN !== "false"
  });
  const targets = [];
  for (const channel of channels) {
    const binding = await getVerifiedBinding(env.db, input.userId, channel);
    if (binding) {
      targets.push({
        channel,
        bindingId: binding.id,
        address: binding.externalId
      });
    }
  }
  return {
    decisionVersion: null,
    targets,
    deferUntil: null,
    skipReason: !channels.length ? "not_subscribed" : targets.length ? null : "not_bound"
  };
}

export async function consumeNotificationBindingChallenge(env, input) {
  return callDirectory(env, "consumeBindingChallenge", input);
}

export async function updateNotificationBindingStatus(env, input) {
  return callDirectory(env, "updateBindingStatus", input);
}

export async function createDirectoryBindingChallenge(env, input) {
  return callDirectory(env, "createBindingChallenge", input);
}

export async function getDirectoryBindingChallengeStatus(env, input) {
  return callDirectory(env, "getBindingChallengeStatus", input);
}

export async function listDirectoryNotificationBindings(env, userId) {
  const result = await callDirectory(env, "listNotificationBindings", { userId });
  return Array.isArray(result) ? result : [];
}

export async function revokeDirectoryNotificationBinding(env, input) {
  return callDirectory(env, "revokeNotificationBinding", input);
}
