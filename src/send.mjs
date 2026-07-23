import { getVerifiedBinding } from "./bindings.mjs";
import { sendWechatTemplate } from "./channels/wechat-send.mjs";

function nowIso() {
  return new Date().toISOString();
}

/**
 * Orchestrate notification send for one user.
 * @param {object} env
 * @param {object} input
 * @param {{ clientId: string, serviceId: string }} client
 * @param {{ sendWechat?: Function }} [deps] test doubles
 */
export async function sendNotification(env, input, client, deps = {}) {
  const userId = String(input.user_id || input.userId || "");
  const serviceId = String(input.service_id || input.serviceId || client.serviceId || "");
  const eventType = String(input.event || input.event_type || "generic");
  const channels = Array.isArray(input.channels) && input.channels.length
    ? input.channels.map(String)
    : ["wechat_oa"];
  const title = input.title || "";
  const body = input.body || "";
  const linkUrl = input.url || null;
  const data = input.data || {};
  const strict = Boolean(input.strict);

  if (!userId) {
    return { ok: false, error: "user_id is required", results: [] };
  }

  const results = [];
  for (const channel of channels) {
    if (channel === "wechat_oa") {
      const r = await sendWechatChannel(env, {
        userId,
        serviceId,
        clientId: client.clientId,
        eventType,
        title,
        body,
        linkUrl,
        data,
        sendWechat: deps.sendWechat
      });
      results.push(r);
      if (strict && r.status === "skipped" && r.error === "not_bound") {
        return { ok: false, error: "not_bound", results };
      }
      continue;
    }
    results.push({
      channel,
      status: "skipped",
      error: "channel_not_implemented"
    });
    await writeLog(env.db, {
      userId,
      serviceId,
      clientId: client.clientId,
      eventType,
      channel,
      status: "skipped",
      error: "channel_not_implemented",
      payload: { title, body }
    });
  }

  const anySent = results.some((r) => r.status === "sent");
  const allSkippedUnbound = results.every((r) => r.status === "skipped" && r.error === "not_bound");
  return {
    ok: true,
    results,
    summary: anySent ? "sent" : allSkippedUnbound ? "not_bound" : "partial"
  };
}

async function sendWechatChannel(env, ctx) {
  const binding = await getVerifiedBinding(env.db, ctx.userId, "wechat_oa");
  if (!binding) {
    const logId = await writeLog(env.db, {
      userId: ctx.userId,
      serviceId: ctx.serviceId,
      clientId: ctx.clientId,
      eventType: ctx.eventType,
      channel: "wechat_oa",
      status: "skipped",
      error: "not_bound",
      payload: { title: ctx.title, body: ctx.body }
    });
    return { channel: "wechat_oa", status: "skipped", error: "not_bound", logId };
  }

  const templateId =
    ctx.data?.template_id ||
    ctx.data?.templateId ||
    env.WECHAT_DEFAULT_TEMPLATE_ID ||
    "DEFAULT_TEMPLATE";

  const templateData =
    ctx.data?.template ||
    ctx.data?.data ||
    buildDefaultTemplateData(ctx.title, ctx.body);

  const sendFn = ctx.sendWechat || sendWechatTemplate;
  const sent = await sendFn(env, {
    openid: binding.externalId,
    templateId,
    data: templateData,
    url: ctx.linkUrl
  });

  if (!sent.ok) {
    const logId = await writeLog(env.db, {
      userId: ctx.userId,
      serviceId: ctx.serviceId,
      clientId: ctx.clientId,
      eventType: ctx.eventType,
      channel: "wechat_oa",
      status: "failed",
      error: sent.error,
      providerMsgId: sent.providerMsgId,
      payload: { title: ctx.title, body: ctx.body, openid: binding.externalId }
    });
    return { channel: "wechat_oa", status: "failed", error: sent.error, logId };
  }

  const logId = await writeLog(env.db, {
    userId: ctx.userId,
    serviceId: ctx.serviceId,
    clientId: ctx.clientId,
    eventType: ctx.eventType,
    channel: "wechat_oa",
    status: "sent",
    providerMsgId: sent.providerMsgId,
    payload: { title: ctx.title, body: ctx.body }
  });
  return {
    channel: "wechat_oa",
    status: "sent",
    providerMsgId: sent.providerMsgId,
    logId
  };
}

function buildDefaultTemplateData(title, body) {
  return {
    thing1: { value: String(title || "通知").slice(0, 20) },
    thing2: { value: String(body || "-").slice(0, 20) }
  };
}

export async function writeLog(db, item) {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO notification_logs
       (id, user_id, service_id, client_id, event_type, channel, status, provider_msg_id, error, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      item.userId || null,
      item.serviceId || null,
      item.clientId || null,
      item.eventType || null,
      item.channel || null,
      item.status,
      item.providerMsgId || null,
      item.error || null,
      JSON.stringify(item.payload || {}),
      nowIso()
    )
    .run();
  return id;
}

export async function listLogs(db, { userId, limit = 50 } = {}) {
  if (userId) {
    const { results } = await db
      .prepare(
        `SELECT id, user_id AS userId, service_id AS serviceId, event_type AS eventType,
                channel, status, error, created_at AS createdAt
         FROM notification_logs WHERE user_id = ?
         ORDER BY created_at DESC LIMIT ?`
      )
      .bind(userId, limit)
      .all();
    return results || [];
  }
  const { results } = await db
    .prepare(
      `SELECT id, user_id AS userId, service_id AS serviceId, event_type AS eventType,
              channel, status, error, created_at AS createdAt
       FROM notification_logs
       ORDER BY created_at DESC LIMIT ?`
    )
    .bind(limit)
    .all();
  return results || [];
}
