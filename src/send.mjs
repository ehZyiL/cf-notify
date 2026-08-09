import { HttpError } from "./http.mjs";

function nowIso() {
  return new Date().toISOString();
}

/**
 * List recent notification delivery logs, merging deliveries and events.
 */
export async function listLogs(db, { userId, limit = 50 } = {}) {
  const boundedLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const union = `
    SELECT d.id, d.event_id, e.user_id, e.service_id, e.event_type, d.channel, d.status,
           d.error_code AS error, d.attempts, d.created_at, d.updated_at, 'delivery' AS source
    FROM notification_deliveries d
    JOIN notification_events e ON e.id = d.event_id`;
  if (userId) {
    const { results } = await db
      .prepare(
        `SELECT id, event_id AS eventId, user_id AS userId, service_id AS serviceId,
                event_type AS eventType, channel, status, error, attempts,
                source, created_at AS createdAt, updated_at AS updatedAt
         FROM (${union}) WHERE user_id = ?
         ORDER BY created_at DESC LIMIT ?`
      )
      .bind(userId, boundedLimit)
      .all();
    return results || [];
  }
  const { results } = await db
    .prepare(
      `SELECT id, event_id AS eventId, user_id AS userId, service_id AS serviceId,
              event_type AS eventType, channel, status, error, attempts,
              source, created_at AS createdAt, updated_at AS updatedAt
       FROM (${union})
       ORDER BY created_at DESC LIMIT ?`
    )
    .bind(boundedLimit)
    .all();
  return results || [];
}