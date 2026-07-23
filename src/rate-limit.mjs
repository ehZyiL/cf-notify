/**
 * Simple KV fixed-window rate limits for bind codes.
 */

export async function consumeLimit(kv, key, { limit, windowSec, now = Date.now() }) {
  if (!kv || limit <= 0) return { allowed: true, remaining: Infinity };
  const windowId = Math.floor(now / (windowSec * 1000));
  const fullKey = `rl:${key}:${windowId}`;
  const raw = await kv.get(fullKey);
  let count = raw ? Number(raw) : 0;
  if (!Number.isFinite(count) || count < 0) count = 0;
  if (count >= limit) {
    const resetSec = Math.ceil(((windowId + 1) * windowSec * 1000 - now) / 1000);
    return { allowed: false, remaining: 0, resetSec: Math.max(1, resetSec) };
  }
  count += 1;
  await kv.put(fullKey, String(count), { expirationTtl: windowSec + 5 });
  return { allowed: true, remaining: Math.max(0, limit - count), resetSec: 0 };
}

export function clientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

/** Bind code: max 3 per user per minute; max 10 bad attempts per openid per minute */
export async function assertBindCodeAllowed(kv, userId, request) {
  const ip = clientIp(request);
  const userLim = await consumeLimit(kv, `bind-user:${userId}`, { limit: 3, windowSec: 60 });
  if (!userLim.allowed) {
    return { status: 429, error: "too many bind code requests", retryAfterSec: userLim.resetSec };
  }
  const ipLim = await consumeLimit(kv, `bind-ip:${ip}`, { limit: 20, windowSec: 60 });
  if (!ipLim.allowed) {
    return { status: 429, error: "too many bind code requests from this network", retryAfterSec: ipLim.resetSec };
  }
  return null;
}

export async function assertOpenidCodeAttemptAllowed(kv, openid) {
  const lim = await consumeLimit(kv, `bind-openid-fail:${openid}`, { limit: 10, windowSec: 60 });
  if (!lim.allowed) {
    return { allowed: false, error: "too many invalid codes" };
  }
  return { allowed: true };
}
