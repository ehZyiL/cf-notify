import { getVerifiedBinding } from "./bindings.mjs";
import { sendWechatTemplate } from "./channels/wechat-send.mjs";
import { sendTelegram } from "./channels/telegram-send.mjs";
import { isSubscribed } from "./subscriptions.mjs";
import { getChannelApp, resolveTemplate } from "./templates.mjs";

function nowIso() {
  return new Date().toISOString();
}

/**
 * Orchestrate notification send for one user.
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

  const subscribed = await isSubscribed(env.db, { userId, serviceId, eventType });
  if (!subscribed) {
    const logId = await writeLog(env.db, {
      userId,
      serviceId,
      clientId: client.clientId,
      eventType,
      channel: channels[0] || "wechat_oa",
      status: "skipped",
      error: "not_subscribed",
      payload: { title, body }
    });
    return {
      ok: true,
      results: [{ channel: channels[0] || "wechat_oa", status: "skipped", error: "not_subscribed", logId }],
      summary: "not_subscribed"
    };
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
    if (channel === "telegram") {
      const binding = await getVerifiedBinding(env.db, userId, "telegram");
      if (!binding) {
        const logId = await writeLog(env.db, {
          userId,
          serviceId,
          clientId: client.clientId,
          eventType,
          channel: "telegram",
          status: "skipped",
          error: "not_bound",
          payload: { title, body }
        });
        results.push({ channel: "telegram", status: "skipped", error: "not_bound", logId });
        continue;
      }
      const sendTg = deps.sendTelegram || sendTelegram;
      const sent = await sendTg(env, {
        chatId: binding.externalId,
        text: [title, body].filter(Boolean).join("\n")
      });
      const status = sent.ok ? "sent" : sent.error === "telegram_not_implemented" ? "skipped" : "failed";
      const logId = await writeLog(env.db, {
        userId,
        serviceId,
        clientId: client.clientId,
        eventType,
        channel: "telegram",
        status,
        error: sent.ok ? null : sent.error,
        payload: { title, body }
      });
      results.push({ channel: "telegram", status, error: sent.error || null, logId });
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

  const app = await getChannelApp(env.db, "wechat_oa");
  const resolved = resolveTemplate(app?.templateMapJson, ctx.eventType, {
    title: ctx.title,
    body: ctx.body,
    data: ctx.data
  });
  const templateId = resolved.templateId || env.WECHAT_DEFAULT_TEMPLATE_ID || "DEFAULT_TEMPLATE";

  const sendFn = ctx.sendWechat || sendWechatTemplate;
  const sent = await sendFn(env, {
    openid: binding.externalId,
    templateId,
    data: resolved.templateData,
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

/** Retry failed logs once (simple P1.5 skeleton). */
export async function retryFailedLogs(env, { limit = 20, sendWechat } = {}) {
  const { results } = await env.db
    .prepare(
      `SELECT id, user_id AS userId, service_id AS serviceId, client_id AS clientId,
              event_type AS eventType, channel, payload_json AS payloadJson
       FROM notification_logs WHERE status = 'failed' AND channel = 'wechat_oa'
       ORDER BY created_at ASC LIMIT ?`
    )
    .bind(limit)
    .all();
  const out = [];
  for (const row of results || []) {
    let payload = {};
    try {
      payload = JSON.parse(row.payloadJson || "{}");
    } catch {
      /* ignore */
    }
    const result = await sendNotification(
      env,
      {
        user_id: row.userId,
        service_id: row.serviceId,
        event: row.eventType,
        title: payload.title || "retry",
        body: payload.body || "",
        channels: ["wechat_oa"]
      },
      { clientId: row.clientId || "retry", serviceId: row.serviceId || "retry" },
      { sendWechat }
    );
    out.push({ logId: row.id, result });
  }
  return out;
}
