/** Simple KV fixed-window rate limits. */

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

export async function assertOpenidCodeAttemptAllowed(kv, openid) {
  const lim = await consumeLimit(kv, `bind-openid-fail:${openid}`, { limit: 10, windowSec: 60 });
  if (!lim.allowed) {
    return { allowed: false, error: "too many invalid codes" };
  }
  return { allowed: true };
}
