import { getVerifiedBinding } from "./bindings.mjs";
import { deliverToChannel } from "./channels/index.mjs";
import { HttpError } from "./http.mjs";
import { isChannelSubscribed, resolveSubscribedChannels } from "./subscriptions.mjs";

const EVENT_TERMINAL = new Set(["completed", "partially_failed", "skipped", "failed"]);
const DELIVERY_TERMINAL = new Set(["sent", "delivered", "unknown", "failed", "skipped"]);
const FORBIDDEN_TARGET_FIELDS = ["to", "email", "phone", "openid", "chat_id", "device_token"];
const FORBIDDEN_DATA_FIELDS = new Set([
  "to",
  "email",
  "phone",
  "openid",
  "chat_id",
  "device_token",
  "template",
  "template_id",
  "templateid",
  "providertemplateid"
]);
const SUPPORTED_CHANNELS = new Set(["wechat_oa", "telegram"]);

function nowIso() {
  return new Date().toISOString();
}

function safeJson(value, fallback = {}) {
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return fallback;
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])])
    );
  }
  return value;
}

function validateEventData(value, depth = 0, tracker = { properties: 0 }) {
  if (depth > 6) throw new HttpError(400, "data exceeds maximum depth");
  if (value == null || typeof value === "boolean" || typeof value === "number") return;
  if (typeof value === "string") {
    if (value.length > 4000) throw new HttpError(400, "data string is too long");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) throw new HttpError(400, "data array is too large");
    for (const item of value) validateEventData(item, depth + 1, tracker);
    return;
  }
  if (typeof value !== "object") throw new HttpError(400, "data contains an unsupported value");
  for (const [key, item] of Object.entries(value)) {
    tracker.properties += 1;
    if (tracker.properties > 50) throw new HttpError(400, "data has too many properties");
    if (FORBIDDEN_DATA_FIELDS.has(key.toLowerCase())) {
      throw new HttpError(400, `${key} is controlled by cf-notify and is not accepted in data`);
    }
    validateEventData(item, depth + 1, tracker);
  }
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function eventFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    serviceId: row.serviceId ?? row.service_id,
    clientId: row.clientId ?? row.client_id,
    userId: row.userId ?? row.user_id,
    eventType: row.eventType ?? row.event_type,
    idempotencyKey: row.idempotencyKey ?? row.idempotency_key,
    requestHash: row.requestHash ?? row.request_hash,
    payload: safeJson(row.payloadJson ?? row.payload_json, {}),
    locale: row.locale || null,
    occurredAt: row.occurredAt ?? row.occurred_at,
    status: row.status,
    skipReason: row.skipReason ?? row.skip_reason ?? null,
    createdAt: row.createdAt ?? row.created_at,
    updatedAt: row.updatedAt ?? row.updated_at
  };
}

function deliveryFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    eventId: row.eventId ?? row.event_id,
    channel: row.channel,
    bindingId: row.bindingId ?? row.binding_id ?? null,
    targetKey: row.targetKey ?? row.target_key,
    status: row.status,
    attempts: Number(row.attempts || 0),
    nextAttemptAt: row.nextAttemptAt ?? row.next_attempt_at ?? null,
    providerMessageId: row.providerMessageId ?? row.provider_message_id ?? null,
    errorCode: row.errorCode ?? row.error_code ?? null,
    createdAt: row.createdAt ?? row.created_at,
    updatedAt: row.updatedAt ?? row.updated_at
  };
}

function normalizeInput(input, client) {
  const userId = String(input.userId || input.user_id || "").trim();
  const eventType = String(input.type || input.event || input.event_type || "generic").trim();
  const requestedServiceId = String(input.serviceId || input.service_id || "").trim();
  if (!userId) throw new HttpError(400, "userId is required");
  if (userId.length > 128) throw new HttpError(400, "userId is too long");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(eventType)) {
    throw new HttpError(400, "type is invalid");
  }
  if (requestedServiceId && requestedServiceId !== client.serviceId) {
    throw new HttpError(403, "serviceId does not match authenticated client");
  }
  for (const field of FORBIDDEN_TARGET_FIELDS) {
    if (input[field] != null) throw new HttpError(400, `${field} is not accepted; recipients are resolved by cf-notify`);
  }

  const rawChannels = Array.isArray(input.channels) && input.channels.length
    ? input.channels
    : ["wechat_oa"];
  const channels = [...new Set(rawChannels.map((channel) => String(channel).trim()))];
  if (channels.length > 8 || channels.some((channel) => !SUPPORTED_CHANNELS.has(channel))) {
    throw new HttpError(400, "channels is invalid");
  }

  if (input.data != null && (typeof input.data !== "object" || Array.isArray(input.data))) {
    throw new HttpError(400, "data must be an object");
  }
  const data = input.data || {};
  validateEventData(data);
  let linkUrl = null;
  if (input.url) {
    try {
      const parsed = new URL(String(input.url));
      if (parsed.protocol !== "https:") throw new Error("not https");
      linkUrl = parsed.toString().slice(0, 2048);
    } catch {
      throw new HttpError(400, "url must be a valid HTTPS URL");
    }
  }

  const occurredAt = input.occurredAt || input.occurred_at || nowIso();
  if (Number.isNaN(Date.parse(occurredAt))) throw new HttpError(400, "occurredAt is invalid");
  return {
    userId,
    eventType,
    locale: input.locale ? String(input.locale).slice(0, 32) : null,
    occurredAt: new Date(occurredAt).toISOString(),
    payload: {
      title: String(input.title || "").slice(0, 200),
      body: String(input.body || "").slice(0, 4000),
      url: linkUrl,
      data,
      channels
    }
  };
}

export async function getNotificationEvent(db, eventId) {
  const row = await db
    .prepare(
      `SELECT id, service_id AS serviceId, client_id AS clientId, user_id AS userId,
              event_type AS eventType, idempotency_key AS idempotencyKey,
              request_hash AS requestHash, payload_json AS payloadJson, locale,
              occurred_at AS occurredAt, status, skip_reason AS skipReason,
              created_at AS createdAt, updated_at AS updatedAt
       FROM notification_events WHERE id = ?`
    )
    .bind(eventId)
    .first();
  return eventFromRow(row);
}

export async function listEventDeliveries(db, eventId) {
  const { results } = await db
    .prepare(
      `SELECT id, event_id AS eventId, channel, binding_id AS bindingId,
              target_key AS targetKey, status, attempts, next_attempt_at AS nextAttemptAt,
              provider_message_id AS providerMessageId, error_code AS errorCode,
              created_at AS createdAt, updated_at AS updatedAt
       FROM notification_deliveries WHERE event_id = ? ORDER BY created_at, id`
    )
    .bind(eventId)
    .all();
  return (results || []).map(deliveryFromRow);
}

export async function ingestNotificationEvent(env, input, client, idempotencyKey) {
  const key = String(idempotencyKey || "").trim();
  if (!key) throw new HttpError(400, "Idempotency-Key header is required");
  if (key.length > 200) throw new HttpError(400, "Idempotency-Key is too long");
  if (/[^\x21-\x7e]/.test(key)) throw new HttpError(400, "Idempotency-Key contains invalid characters");
  if (!env.dispatchQueue) throw new HttpError(503, "notification queue is not configured");

  const normalized = normalizeInput(input, client);
  // An omitted occurredAt means "ingestion time" and must not make an otherwise
  // identical idempotent replay conflict with the first request.
  const hashValue = input.occurredAt || input.occurred_at
    ? normalized
    : { ...normalized, occurredAt: null };
  const canonical = JSON.stringify(stableValue(hashValue));
  if (new TextEncoder().encode(canonical).byteLength > 64 * 1024) {
    throw new HttpError(413, "notification payload is too large");
  }
  const requestHash = await sha256Hex(canonical);
  const id = `evt_${crypto.randomUUID().replace(/-/g, "")}`;
  const now = nowIso();
  const result = await env.db
    .prepare(
      `INSERT OR IGNORE INTO notification_events
       (id, service_id, client_id, user_id, event_type, idempotency_key, request_hash,
        payload_json, locale, occurred_at, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?)`
    )
    .bind(
      id,
      client.serviceId,
      client.clientId,
      normalized.userId,
      normalized.eventType,
      key,
      requestHash,
      JSON.stringify(normalized.payload),
      normalized.locale,
      normalized.occurredAt,
      now,
      now
    )
    .run();

  const duplicate = Number(result?.meta?.changes || 0) === 0;
  const row = await env.db
    .prepare(
      `SELECT id, request_hash AS requestHash, status, dispatch_queued_at AS dispatchQueuedAt
       FROM notification_events WHERE service_id = ? AND idempotency_key = ?`
    )
    .bind(client.serviceId, key)
    .first();
  if (!row) throw new Error("notification event insert was not visible");
  if (row.requestHash !== requestHash) {
    throw new HttpError(409, "Idempotency-Key was already used with a different request");
  }

  let queued = Boolean(row.dispatchQueuedAt);
  if (!queued) queued = await enqueueEvent(env, row.id);
  if (!queued) {
    throw new HttpError(503, "notification was saved but could not be queued", {
      eventId: row.id,
      retryable: true,
      retryAfterSec: 5
    });
  }
  return { eventId: row.id, status: row.status, duplicate, queued };
}

async function enqueueEvent(env, eventId) {
  const now = nowIso();
  try {
    await env.dispatchQueue.send({ eventId });
    await env.db
      .prepare(
        `UPDATE notification_events
         SET dispatch_queued_at = ?, last_enqueue_error = NULL, updated_at = ? WHERE id = ?`
      )
      .bind(now, now, eventId)
      .run();
    return true;
  } catch (error) {
    const detail = String(error?.message || error).slice(0, 500);
    await env.db
      .prepare(
        `UPDATE notification_events SET last_enqueue_error = ?, updated_at = ? WHERE id = ?`
      )
      .bind(detail, now, eventId)
      .run();
    console.error(JSON.stringify({ event: "dispatch_enqueue_failed", eventId, error: detail }));
    return false;
  }
}

async function createDelivery(db, { eventId, channel, bindingId, targetKey, status, errorCode }) {
  const id = `dlv_${crypto.randomUUID().replace(/-/g, "")}`;
  const now = nowIso();
  await db
    .prepare(
      `INSERT OR IGNORE INTO notification_deliveries
       (id, event_id, channel, binding_id, target_key, status, error_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, eventId, channel, bindingId, targetKey, status, errorCode || null, now, now)
    .run();
  const row = await db
    .prepare(
      `SELECT id, event_id AS eventId, channel, binding_id AS bindingId,
              target_key AS targetKey, status, attempts, next_attempt_at AS nextAttemptAt,
              provider_message_id AS providerMessageId, error_code AS errorCode,
              created_at AS createdAt, updated_at AS updatedAt
       FROM notification_deliveries WHERE event_id = ? AND channel = ? AND target_key = ?`
    )
    .bind(eventId, channel, targetKey)
    .first();
  return deliveryFromRow(row);
}

async function enqueueDelivery(env, deliveryId) {
  const now = nowIso();
  try {
    await env.deliveryQueue.send({ deliveryId });
    await env.db
      .prepare(
        `UPDATE notification_deliveries
         SET enqueued_at = ?, last_enqueue_error = NULL, updated_at = ? WHERE id = ?`
      )
      .bind(now, now, deliveryId)
      .run();
    return true;
  } catch (error) {
    const detail = String(error?.message || error).slice(0, 500);
    await env.db
      .prepare(
        `UPDATE notification_deliveries SET last_enqueue_error = ?, updated_at = ? WHERE id = ?`
      )
      .bind(detail, now, deliveryId)
      .run();
    console.error(JSON.stringify({ event: "delivery_enqueue_failed", deliveryId, error: detail }));
    return false;
  }
}

export async function dispatchEvent(env, eventId) {
  const event = await getNotificationEvent(env.db, eventId);
  if (!event || EVENT_TERMINAL.has(event.status)) return { terminal: true };
  if (!env.deliveryQueue) throw new Error("delivery queue is not configured");

  const now = nowIso();
  await env.db
    .prepare("UPDATE notification_events SET status = 'dispatching', updated_at = ? WHERE id = ?")
    .bind(now, event.id)
    .run();

  const channels = await resolveSubscribedChannels(env.db, {
    userId: event.userId,
    serviceId: event.serviceId,
    eventType: event.eventType,
    channels: event.payload.channels || ["wechat_oa"],
    defaultOpen: env.SUBSCRIPTIONS_DEFAULT_OPEN !== "false"
  });
  if (!channels.length) {
    await env.db
      .prepare(
        `UPDATE notification_events
         SET status = 'skipped', skip_reason = 'not_subscribed', updated_at = ? WHERE id = ?`
      )
      .bind(nowIso(), event.id)
      .run();
    return { terminal: true, status: "skipped" };
  }

  let enqueueFailed = false;
  for (const channel of channels) {
    const binding = await getVerifiedBinding(env.db, event.userId, channel);
    if (!binding) {
      await createDelivery(env.db, {
        eventId: event.id,
        channel,
        bindingId: null,
        targetKey: `unbound:${channel}`,
        status: "skipped",
        errorCode: "not_bound"
      });
      continue;
    }
    const delivery = await createDelivery(env.db, {
      eventId: event.id,
      channel,
      bindingId: binding.id,
      targetKey: binding.id,
      status: "pending"
    });
    if (!DELIVERY_TERMINAL.has(delivery.status)) {
      const queued = await enqueueDelivery(env, delivery.id);
      if (!queued) enqueueFailed = true;
    }
  }
  await aggregateEventStatus(env.db, event.id);
  if (enqueueFailed) throw new Error("one or more deliveries could not be enqueued");
  return { terminal: false };
}

async function loadDeliveryContext(db, deliveryId) {
  const row = await db
    .prepare(
      `SELECT d.id, d.event_id AS eventId, d.channel, d.binding_id AS bindingId,
              d.target_key AS targetKey, d.status, d.attempts,
              e.service_id AS serviceId, e.user_id AS userId, e.event_type AS eventType,
              e.payload_json AS payloadJson
       FROM notification_deliveries d
       JOIN notification_events e ON e.id = d.event_id
       WHERE d.id = ?`
    )
    .bind(deliveryId)
    .first();
  if (!row) return null;
  return { ...deliveryFromRow(row), serviceId: row.serviceId, userId: row.userId, eventType: row.eventType, payload: safeJson(row.payloadJson, {}) };
}

async function markDeliverySkipped(db, delivery, errorCode) {
  const now = nowIso();
  await db
    .prepare(
      `UPDATE notification_deliveries
       SET status = 'skipped', error_code = ?, error_detail = NULL, updated_at = ? WHERE id = ?`
    )
    .bind(errorCode, now, delivery.id)
    .run();
  await aggregateEventStatus(db, delivery.eventId);
}

export async function deliverNotification(env, deliveryId, deps = {}) {
  const delivery = await loadDeliveryContext(env.db, deliveryId);
  if (!delivery || DELIVERY_TERMINAL.has(delivery.status)) return { terminal: true };

  const subscribed = await isChannelSubscribed(env.db, {
    userId: delivery.userId,
    serviceId: delivery.serviceId,
    eventType: delivery.eventType,
    channel: delivery.channel,
    defaultOpen: env.SUBSCRIPTIONS_DEFAULT_OPEN !== "false"
  });
  if (!subscribed) {
    await markDeliverySkipped(env.db, delivery, "not_subscribed");
    return { terminal: true };
  }

  const binding = await getVerifiedBinding(env.db, delivery.userId, delivery.channel);
  if (!binding) {
    await markDeliverySkipped(env.db, delivery, "not_bound");
    return { terminal: true };
  }
  if (binding.id !== delivery.bindingId) {
    await markDeliverySkipped(env.db, delivery, "binding_changed");
    return { terminal: true };
  }

  const startedAt = nowIso();
  const staleAfterSec = Number(env.RECONCILE_AFTER_SEC || 120);
  const staleCutoff = new Date(Date.now() - staleAfterSec * 1000).toISOString();
  const claim = await env.db
    .prepare(
      `UPDATE notification_deliveries
       SET status = 'sending', attempts = attempts + 1, next_attempt_at = NULL, updated_at = ?
       WHERE id = ? AND (
         status = 'pending'
         OR (status = 'retrying' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
         OR (status = 'sending' AND updated_at <= ?)
       )`
    )
    .bind(startedAt, delivery.id, startedAt, staleCutoff)
    .run();
  if (Number(claim?.meta?.changes || 0) === 0) return { terminal: true, claimed: false };

  let result;
  try {
    result = await deliverToChannel(
      env,
      {
        channel: delivery.channel,
        binding,
        event: { eventType: delivery.eventType, deliveryId: delivery.id },
        payload: delivery.payload
      },
      deps
    );
  } catch (error) {
    result = {
      ok: false,
      retryable: true,
      outcomeUnknown: true,
      errorCode: "adapter_exception",
      error: String(error?.message || error)
    };
  }

  const finishedAt = nowIso();
  if (result.ok) {
    await env.db
      .prepare(
        `UPDATE notification_deliveries
         SET status = 'sent', provider_message_id = ?, error_code = NULL, error_detail = NULL,
             sent_at = ?, updated_at = ? WHERE id = ?`
      )
      .bind(result.providerMsgId || null, finishedAt, finishedAt, delivery.id)
      .run();
    await aggregateEventStatus(env.db, delivery.eventId);
    return { terminal: true };
  }

  const errorDetail = String(result.error || result.errorCode || "delivery failed").slice(0, 500);
  if (result.retryable) {
    const attempts = delivery.attempts + 1;
    const delaySeconds = Math.min(900, 15 * 2 ** Math.min(attempts - 1, 6));
    const nextAttemptAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
    await env.db
      .prepare(
        `UPDATE notification_deliveries
         SET status = 'retrying', error_code = ?, error_detail = ?, next_attempt_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(
        result.outcomeUnknown ? "provider_outcome_unknown" : result.errorCode || "temporary_failure",
        errorDetail,
        nextAttemptAt,
        finishedAt,
        delivery.id
      )
      .run();
    return { terminal: false, retry: true, delaySeconds };
  }

  await env.db
    .prepare(
      `UPDATE notification_deliveries
       SET status = 'failed', error_code = ?, error_detail = ?, updated_at = ? WHERE id = ?`
    )
    .bind(result.errorCode || "permanent_failure", errorDetail, finishedAt, delivery.id)
    .run();
  await aggregateEventStatus(env.db, delivery.eventId);
  return { terminal: true };
}

export async function aggregateEventStatus(db, eventId) {
  const { results } = await db
    .prepare("SELECT status FROM notification_deliveries WHERE event_id = ?")
    .bind(eventId)
    .all();
  const statuses = (results || []).map((row) => row.status);
  if (!statuses.length) return "dispatching";

  let status;
  if (statuses.some((value) => !DELIVERY_TERMINAL.has(value))) status = "dispatching";
  else if (statuses.every((value) => value === "skipped")) status = "skipped";
  else if (statuses.every((value) => value === "sent" || value === "delivered")) status = "completed";
  else if (statuses.some((value) => value === "sent" || value === "delivered")) status = "partially_failed";
  else status = "failed";

  await db
    .prepare("UPDATE notification_events SET status = ?, updated_at = ? WHERE id = ?")
    .bind(status, nowIso(), eventId)
    .run();
  return status;
}

function messageRetry(message, delaySeconds) {
  if (typeof message.retry === "function") message.retry(delaySeconds ? { delaySeconds } : undefined);
}

function messageAck(message) {
  if (typeof message.ack === "function") message.ack();
}

export async function processQueueBatch(batch, env, deps = {}) {
  const queueName = String(batch.queue || "");
  const isDlq = queueName.endsWith("-dlq");
  for (const message of batch.messages || []) {
    try {
      const kind = message.body?.eventId
        ? "dispatch"
        : message.body?.deliveryId
          ? "delivery"
          : null;
      if (!kind) {
        console.error(JSON.stringify({
          event: "invalid_queue_message",
          queue: queueName,
          messageId: message.id || null
        }));
        messageAck(message);
        continue;
      }
      if (isDlq) {
        await processDeadLetter(env, message.body, kind);
        messageAck(message);
      } else if (kind === "dispatch") {
        await dispatchEvent(env, message.body?.eventId);
        messageAck(message);
      } else {
        const result = await deliverNotification(env, message.body?.deliveryId, deps);
        if (result.retry) messageRetry(message, result.delaySeconds);
        else messageAck(message);
      }
    } catch (error) {
      console.error(JSON.stringify({
        event: "queue_message_failed",
        queue: queueName,
        messageId: message.id || null,
        error: String(error?.message || error).slice(0, 500)
      }));
      messageRetry(message);
    }
  }
}

export async function processDeadLetter(env, body, kind) {
  const now = nowIso();
  if (kind === "dispatch" && body?.eventId) {
    await env.db
      .prepare(
        `UPDATE notification_events
         SET status = 'failed', skip_reason = 'dispatch_dlq', updated_at = ?
         WHERE id = ? AND status NOT IN ('completed', 'partially_failed', 'skipped')`
      )
      .bind(now, body.eventId)
      .run();
    return;
  }
  if (kind === "delivery" && body?.deliveryId) {
    const row = await env.db
      .prepare("SELECT event_id AS eventId, error_code AS errorCode FROM notification_deliveries WHERE id = ?")
      .bind(body.deliveryId)
      .first();
    if (!row) return;
    const status = row.errorCode === "provider_outcome_unknown" ? "unknown" : "failed";
    await env.db
      .prepare(
        `UPDATE notification_deliveries
         SET status = ?, error_code = 'delivery_dlq', next_attempt_at = NULL, updated_at = ?
         WHERE id = ? AND status NOT IN ('sent', 'delivered', 'skipped')`
      )
      .bind(status, now, body.deliveryId)
      .run();
    await aggregateEventStatus(env.db, row.eventId);
  }
}

export async function reconcileQueues(env, options = {}) {
  const limit = Math.min(100, Number(options.limit || env.RECONCILE_BATCH_SIZE || 50));
  const staleSeconds = Number(options.staleSeconds || env.RECONCILE_AFTER_SEC || 120);
  const cutoff = new Date(Date.now() - staleSeconds * 1000).toISOString();
  const now = nowIso();
  let eventsQueued = 0;
  let deliveriesQueued = 0;
  let challengesDeleted = 0;

  if (env.dispatchQueue) {
    const { results } = await env.db
      .prepare(
        `SELECT id FROM notification_events
         WHERE status = 'accepted' AND updated_at <= ? ORDER BY updated_at LIMIT ?`
      )
      .bind(cutoff, limit)
      .all();
    for (const row of results || []) {
      if (await enqueueEvent(env, row.id)) eventsQueued += 1;
    }
  }

  if (env.deliveryQueue) {
    const { results } = await env.db
      .prepare(
        `SELECT id FROM notification_deliveries
         WHERE status IN ('pending', 'retrying', 'sending')
           AND updated_at <= ?
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY updated_at LIMIT ?`
      )
      .bind(cutoff, now, limit)
      .all();
    for (const row of results || []) {
      if (await enqueueDelivery(env, row.id)) deliveriesQueued += 1;
    }
  }
  const cleanup = await env.db
    .prepare("DELETE FROM binding_challenges WHERE expires_at < ?")
    .bind(Date.now() - 24 * 60 * 60 * 1000)
    .run();
  challengesDeleted = Number(cleanup?.meta?.changes || 0);
  await env.db
    .prepare("DELETE FROM wechat_callback_receipts WHERE received_at < ?")
    .bind(Date.now() - 24 * 60 * 60 * 1000)
    .run();
  console.log(JSON.stringify({
    event: "queue_reconciliation",
    eventsQueued,
    deliveriesQueued,
    challengesDeleted
  }));
  return { eventsQueued, deliveriesQueued, challengesDeleted };
}

export async function getEventStatusForService(db, eventId, serviceId) {
  const event = await getNotificationEvent(db, eventId);
  if (!event || event.serviceId !== serviceId) return null;
  const deliveries = await listEventDeliveries(db, eventId);
  return {
    eventId: event.id,
    status: event.status,
    skipReason: event.skipReason,
    occurredAt: event.occurredAt,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    deliveries: deliveries.map((delivery) => ({
      id: delivery.id,
      channel: delivery.channel,
      status: delivery.status,
      attempts: delivery.attempts,
      errorCode: delivery.errorCode,
      providerMessageId: delivery.providerMessageId,
      updatedAt: delivery.updatedAt
    }))
  };
}

export async function retryDelivery(env, deliveryId) {
  const now = nowIso();
  const result = await env.db
    .prepare(
      `UPDATE notification_deliveries
       SET status = 'pending', next_attempt_at = NULL, error_code = NULL, error_detail = NULL, updated_at = ?
       WHERE id = ? AND status IN ('failed', 'unknown')`
    )
    .bind(now, deliveryId)
    .run();
  if (Number(result?.meta?.changes || 0) !== 1) return false;
  return enqueueDelivery(env, deliveryId);
}

export async function retryFailedDeliveries(env, options = {}) {
  if (!env.deliveryQueue) return [];
  const limit = Math.max(1, Math.min(100, Number(options.limit) || 20));
  const { results } = await env.db
    .prepare(
      `SELECT id FROM notification_deliveries
       WHERE status IN ('failed', 'unknown') ORDER BY updated_at LIMIT ?`
    )
    .bind(limit)
    .all();
  const retried = [];
  for (const row of results || []) {
    const queued = await retryDelivery(env, row.id);
    retried.push({ deliveryId: row.id, queued });
  }
  return retried;
}
