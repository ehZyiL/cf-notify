import { hashServiceSecret, verifyServiceSecret } from "./crypto.mjs";
import { HttpError } from "./http.mjs";

function nowIso() {
  return new Date().toISOString();
}

const DEFAULT_SCOPES = ["notifications.send", "notifications.delivery.read"];
const SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,63}$/;

function normalizeScopes(value) {
  const input = value == null ? DEFAULT_SCOPES : Array.isArray(value) ? value : String(value).split(/[\s,]+/);
  const scopes = [...new Set(input.map((scope) => String(scope).trim()).filter(Boolean))];
  if (scopes.length > 20 || scopes.some((scope) => !SCOPE_PATTERN.test(scope))) {
    throw new Error("invalid client scopes");
  }
  return scopes;
}

function parseScopes(value) {
  try {
    return normalizeScopes(JSON.parse(value || "[]"));
  } catch {
    return [];
  }
}

function normalizeExpiresAt(value) {
  if (value == null || value === "") return null;
  const time = Date.parse(String(value));
  if (!Number.isFinite(time) || time <= Date.now()) throw new Error("expiresAt must be in the future");
  return new Date(time).toISOString();
}

export async function createNotifyClient(db, input) {
  const clientId = String(input.clientId || "").trim() || `nc_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const serviceId = String(input.serviceId || "").trim();
  const name = String(input.name || serviceId || clientId);
  const secret = input.clientSecret || crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  if (!serviceId) throw new Error("serviceId is required");
  const scopes = normalizeScopes(input.scopes);
  const expiresAt = normalizeExpiresAt(input.expiresAt);

  const existing = await db.prepare("SELECT client_id FROM notify_clients WHERE client_id = ?").bind(clientId).first();
  if (existing) throw new Error("client already exists");

  const secretHash = await hashServiceSecret(secret);
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO notify_clients
       (client_id, service_id, name, secret_hash, scopes_json, enabled, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`
    )
    .bind(clientId, serviceId, name, secretHash, JSON.stringify(scopes), expiresAt, now, now)
    .run();

  return { clientId, serviceId, name, scopes, expiresAt, clientSecret: secret };
}

export async function getNotifyClient(db, clientId) {
  const row = await db
    .prepare(
      `SELECT client_id AS clientId, service_id AS serviceId, name, secret_hash AS secretHash,
              scopes_json AS scopesJson, enabled, expires_at AS expiresAt,
              created_at AS createdAt, updated_at AS updatedAt
       FROM notify_clients WHERE client_id = ?`
    )
    .bind(clientId)
    .first();
  return row ? { ...row, scopes: parseScopes(row.scopesJson), scopesJson: undefined } : null;
}

export async function listNotifyClients(db) {
  const { results } = await db
    .prepare(
      `SELECT client_id AS clientId, service_id AS serviceId, name, enabled,
              scopes_json AS scopesJson, expires_at AS expiresAt,
              created_at AS createdAt, updated_at AS updatedAt
       FROM notify_clients ORDER BY created_at DESC`
    )
    .all();
  return (results || []).map((row) => ({
    ...row,
    scopes: parseScopes(row.scopesJson),
    scopesJson: undefined
  }));
}

export async function revokeNotifyClient(db, clientId) {
  const now = nowIso();
  const result = await db
    .prepare("UPDATE notify_clients SET enabled = 0, updated_at = ? WHERE client_id = ? AND enabled = 1")
    .bind(now, clientId)
    .run();
  return Number(result?.meta?.changes || 0) === 1;
}

/**
 * Authenticate service client from request headers.
 * Supports: Authorization: Bearer <secret> with X-Notify-Client-Id
 *        or Authorization: Bearer <clientId>:<secret>
 */
export async function requireServiceClient(db, request, options = {}) {
  const auth = request.headers.get("Authorization") || "";
  const headerId = request.headers.get("X-Notify-Client-Id") || "";
  let clientId = headerId.trim();
  let secret = "";

  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) {
    const token = m[1].trim();
    if (token.includes(":") && !clientId) {
      const idx = token.indexOf(":");
      clientId = token.slice(0, idx);
      secret = token.slice(idx + 1);
    } else {
      secret = token;
    }
  }

  if (!clientId || !secret) {
    throw new HttpError(401, "service authentication required");
  }

  const client = await getNotifyClient(db, clientId);
  if (!client || Number(client.enabled) !== 1) {
    throw new HttpError(401, "invalid service client");
  }
  const ok = await verifyServiceSecret(secret, client.secretHash);
  if (!ok) throw new HttpError(401, "invalid service credentials");
  if (client.expiresAt && Date.parse(client.expiresAt) <= Date.now()) {
    throw new HttpError(401, "service credentials expired");
  }
  if (options.scope && !client.scopes.includes(options.scope)) {
    throw new HttpError(403, `missing required scope: ${options.scope}`);
  }

  return {
    clientId: client.clientId,
    serviceId: client.serviceId,
    name: client.name,
    scopes: client.scopes
  };
}
