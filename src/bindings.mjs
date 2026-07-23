import { randomToken } from "./crypto.mjs";
import { HttpError } from "./http.mjs";

const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function nowIso() {
  return new Date().toISOString();
}

function codeKey(code) {
  return `bindcode:${String(code || "").toUpperCase()}`;
}

export function generateBindCode(length = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

/**
 * Create a one-time bind code for an authenticated user.
 */
export async function createBindCode(kv, input, options = {}) {
  const userId = String(input.userId || "");
  const channel = String(input.channel || "wechat_oa");
  const purpose = input.purpose === "wechat_login" ? "wechat_login" : "wechat_bind";
  if (!userId && purpose === "wechat_bind") throw new Error("userId is required for bind");
  if (purpose === "wechat_login" && options.loginEnabled === false) {
    throw new HttpError(403, "wechat code login is disabled");
  }

  const ttlSec = options.ttlSec ?? 300;
  const code = generateBindCode(options.codeLength ?? 6);
  const record = {
    purpose,
    userId: userId || null,
    channel,
    createdAt: Date.now(),
    exp: Date.now() + ttlSec * 1000,
    clientId: input.clientId || null,
    redirectUri: input.redirectUri || null,
    state: input.state || null
  };
  await kv.put(codeKey(code), JSON.stringify(record), { expirationTtl: ttlSec });
  return {
    code,
    expireIn: ttlSec,
    purpose,
    channel
  };
}

export async function getBindCodeStatus(kv, code) {
  const raw = await kv.get(codeKey(code));
  if (!raw) return { status: "expired" };
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return { status: "expired" };
  }
  if (Date.now() >= record.exp) return { status: "expired" };
  if (record.verified) {
    return { status: "verified", userId: record.userId, channel: record.channel };
  }
  return { status: "pending", purpose: record.purpose, channel: record.channel };
}

/**
 * Consume code with openid from wechat callback.
 * @returns {{ ok: boolean, userId?: string, purpose?: string, error?: string }}
 */
export async function consumeBindCode(kv, db, { code, openid, channel = "wechat_oa" }) {
  const key = codeKey(code);
  const raw = await kv.get(key);
  if (!raw) return { ok: false, error: "invalid or expired code" };

  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    await kv.delete(key);
    return { ok: false, error: "invalid code" };
  }
  if (Date.now() >= record.exp) {
    await kv.delete(key);
    return { ok: false, error: "expired code" };
  }
  if (record.channel && record.channel !== channel) {
    return { ok: false, error: "channel mismatch" };
  }
  if (record.purpose !== "wechat_bind" && record.purpose !== "wechat_login") {
    return { ok: false, error: "unsupported purpose" };
  }

  // P1: only wechat_bind fully implemented; login purpose returns structured stub
  if (record.purpose === "wechat_login") {
    await kv.delete(key);
    return {
      ok: true,
      purpose: "wechat_login",
      userId: record.userId,
      openid,
      loginPending: true,
      message: "wechat code login is reserved; enable in Phase 2"
    };
  }

  const userId = record.userId;
  if (!userId) return { ok: false, error: "code missing userId" };

  const bindResult = await upsertBinding(db, {
    userId,
    channel,
    externalId: openid,
    meta: {}
  });
  if (!bindResult.ok) return bindResult;

  // Mark verified for status pollers briefly, then delete
  record.verified = true;
  await kv.put(key, JSON.stringify(record), { expirationTtl: 60 });
  // Immediate delete so code is one-time for re-consume; status can use binding table
  await kv.delete(key);

  return { ok: true, purpose: "wechat_bind", userId, openid, bindingId: bindResult.binding.id };
}

export async function upsertBinding(db, { userId, channel, externalId, meta = {} }) {
  const existing = await db
    .prepare(
      `SELECT id, user_id AS userId, channel, external_id AS externalId, status
       FROM channel_bindings WHERE channel = ? AND external_id = ?`
    )
    .bind(channel, externalId)
    .first();

  if (existing && existing.userId !== userId && existing.status === "verified") {
    return { ok: false, error: "openid already bound to another user" };
  }

  const now = nowIso();
  if (existing) {
    await db
      .prepare(
        `UPDATE channel_bindings
         SET user_id = ?, status = 'verified', meta_json = ?, verified_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(userId, JSON.stringify(meta), now, now, existing.id)
      .run();
    const binding = await getBinding(db, existing.id);
    return { ok: true, binding };
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO channel_bindings
       (id, user_id, channel, external_id, status, meta_json, verified_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'verified', ?, ?, ?, ?)`
    )
    .bind(id, userId, channel, externalId, JSON.stringify(meta), now, now, now)
    .run();
  const binding = await getBinding(db, id);
  return { ok: true, binding };
}

export async function getBinding(db, id) {
  const row = await db
    .prepare(
      `SELECT id, user_id AS userId, channel, external_id AS externalId, status,
              meta_json AS metaJson, verified_at AS verifiedAt, created_at AS createdAt, updated_at AS updatedAt
       FROM channel_bindings WHERE id = ?`
    )
    .bind(id)
    .first();
  if (!row) return null;
  return {
    ...row,
    meta: row.metaJson ? safeJson(row.metaJson) : null,
    metaJson: undefined
  };
}

export async function listBindingsForUser(db, userId) {
  const { results } = await db
    .prepare(
      `SELECT id, user_id AS userId, channel, external_id AS externalId, status,
              meta_json AS metaJson, verified_at AS verifiedAt, created_at AS createdAt, updated_at AS updatedAt
       FROM channel_bindings
       WHERE user_id = ? AND status != 'revoked'
       ORDER BY created_at DESC`
    )
    .bind(userId)
    .all();
  return (results || []).map((row) => ({
    ...row,
    meta: row.metaJson ? safeJson(row.metaJson) : null,
    metaJson: undefined
  }));
}

export async function getVerifiedBinding(db, userId, channel) {
  return db
    .prepare(
      `SELECT id, user_id AS userId, channel, external_id AS externalId, status
       FROM channel_bindings
       WHERE user_id = ? AND channel = ? AND status = 'verified'
       LIMIT 1`
    )
    .bind(userId, channel)
    .first();
}

export async function revokeBinding(db, id, userId) {
  const row = await getBinding(db, id);
  if (!row || row.userId !== userId) return false;
  await db
    .prepare(`UPDATE channel_bindings SET status = 'revoked', updated_at = ? WHERE id = ?`)
    .bind(nowIso(), id)
    .run();
  return true;
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// silence unused
void randomToken;
