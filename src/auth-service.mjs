import { hashSecret, verifySecret } from "./crypto.mjs";
import { HttpError } from "./http.mjs";

function nowIso() {
  return new Date().toISOString();
}

export async function createNotifyClient(db, input) {
  const clientId = String(input.clientId || "").trim() || `nc_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const serviceId = String(input.serviceId || "").trim();
  const name = String(input.name || serviceId || clientId);
  const secret = input.clientSecret || crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  if (!serviceId) throw new Error("serviceId is required");

  const existing = await db.prepare("SELECT client_id FROM notify_clients WHERE client_id = ?").bind(clientId).first();
  if (existing) throw new Error("client already exists");

  const secretHash = await hashSecret(secret);
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO notify_clients (client_id, service_id, name, secret_hash, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`
    )
    .bind(clientId, serviceId, name, secretHash, now, now)
    .run();

  return { clientId, serviceId, name, clientSecret: secret };
}

export async function getNotifyClient(db, clientId) {
  const row = await db
    .prepare(
      `SELECT client_id AS clientId, service_id AS serviceId, name, secret_hash AS secretHash,
              enabled, created_at AS createdAt, updated_at AS updatedAt
       FROM notify_clients WHERE client_id = ?`
    )
    .bind(clientId)
    .first();
  return row || null;
}

export async function listNotifyClients(db) {
  const { results } = await db
    .prepare(
      `SELECT client_id AS clientId, service_id AS serviceId, name, enabled,
              created_at AS createdAt, updated_at AS updatedAt
       FROM notify_clients ORDER BY created_at DESC`
    )
    .all();
  return results || [];
}

/**
 * Authenticate service client from request headers.
 * Supports: Authorization: Bearer <secret> with X-Notify-Client-Id
 *        or Authorization: Bearer <clientId>:<secret>
 */
export async function requireServiceClient(db, request) {
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
  const ok = await verifySecret(secret, client.secretHash);
  if (!ok) throw new HttpError(401, "invalid service credentials");

  return {
    clientId: client.clientId,
    serviceId: client.serviceId,
    name: client.name
  };
}
