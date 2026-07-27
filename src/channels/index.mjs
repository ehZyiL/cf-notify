import { getChannelApp, resolveTemplate } from "../templates.mjs";
import { sendTelegram } from "./telegram-send.mjs";
import { sendWechatCustomText, sendWechatTemplate } from "./wechat-send.mjs";

function normalizeFailure(result, fallbackCode) {
  return {
    ok: false,
    retryable: Boolean(result?.retryable),
    outcomeUnknown: Boolean(result?.outcomeUnknown),
    errorCode: result?.errorCode || fallbackCode,
    error: String(result?.error || fallbackCode).slice(0, 500),
    providerMsgId: result?.providerMsgId || null
  };
}

export async function deliverToChannel(env, { channel, binding, event, payload }, deps = {}) {
  if (channel === "wechat_oa") {
    const customText = String(env.WECHAT_SEND_MODE || "template").toLowerCase() === "custom_text";
    let args;
    let send;
    if (customText) {
      const fallback = typeof payload.data?.message === "string" ? payload.data.message : "";
      const text = [payload.title, payload.body || fallback, payload.url].filter(Boolean).join("\n");
      args = { openid: binding.externalId, text, deliveryId: event.deliveryId };
      send = deps.sendWechat || sendWechatCustomText;
    } else {
      const app = await getChannelApp(env.db, channel);
      const resolved = resolveTemplate(app?.templateMapJson, event.eventType, {
        title: payload.title || "",
        body: payload.body || "",
        data: payload.data || {}
      });
      args = {
        openid: binding.externalId,
        templateId: resolved.templateId || env.WECHAT_DEFAULT_TEMPLATE_ID || "DEFAULT_TEMPLATE",
        data: resolved.templateData,
        url: payload.url || null,
        deliveryId: event.deliveryId
      };
      send = deps.sendWechat || sendWechatTemplate;
    }
    const result = await send(env, args);
    return result?.ok
      ? { ok: true, providerMsgId: result.providerMsgId || null }
      : normalizeFailure(result, "wechat_send_failed");
  }

  if (channel === "telegram") {
    const send = deps.sendTelegram || sendTelegram;
    const result = await send(env, {
      chatId: binding.externalId,
      text: [payload.title, payload.body].filter(Boolean).join("\n")
    });
    return result?.ok
      ? { ok: true, providerMsgId: result.providerMsgId || null }
      : normalizeFailure(result, "telegram_send_failed");
  }

  return {
    ok: false,
    retryable: false,
    outcomeUnknown: false,
    errorCode: "channel_not_implemented",
    error: `channel ${channel} is not implemented`,
    providerMsgId: null
  };
}
