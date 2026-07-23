import { sha1Hex, timingSafeEqual } from "../crypto.mjs";
import { consumeBindCode } from "../bindings.mjs";

/**
 * WeChat server URL verification (GET).
 * signature = sha1(sort(token, timestamp, nonce).join(''))
 */
export async function verifyWechatSignature(token, { signature, timestamp, nonce }) {
  if (!token || !signature || !timestamp || !nonce) return false;
  const arr = [String(token), String(timestamp), String(nonce)].sort();
  const digest = await sha1Hex(arr.join(""));
  return timingSafeEqual(digest, String(signature).toLowerCase());
}

export function parseWechatXml(xml) {
  const result = {};
  for (const match of String(xml || "").matchAll(/<([A-Za-z0-9_]+)>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))\s*<\/\1>/g)) {
    result[match[1]] = match[2] != null ? match[2] : match[3] || "";
  }
  return result;
}

export function wechatTextReply(inbound, content) {
  const now = Math.floor(Date.now() / 1000);
  const text = [
    "<xml>",
    `<ToUserName><![CDATA[${safeCdata(inbound.FromUserName || "")}]]></ToUserName>`,
    `<FromUserName><![CDATA[${safeCdata(inbound.ToUserName || "")}]]></FromUserName>`,
    `<CreateTime>${now}</CreateTime>`,
    "<MsgType><![CDATA[text]]></MsgType>",
    `<Content><![CDATA[${safeCdata(content || "ok")}]]></Content>`,
    "</xml>"
  ].join("");
  return new Response(text, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
}

function safeCdata(value) {
  return String(value == null ? "" : value).replaceAll("]]>", "]]]]><![CDATA[>");
}

/**
 * Handle inbound WeChat message: bind code flow (plaintext mode P1).
 */
export async function handleWechatMessage(env, xmlBody) {
  const msg = parseWechatXml(xmlBody);
  const openid = msg.FromUserName;
  if (!openid) {
    return new Response("success", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  if (msg.MsgType === "event") {
    if (msg.Event === "subscribe") {
      return wechatTextReply(msg, "感谢关注。请在业务系统中生成绑定码，并发送给本公众号完成通知绑定。");
    }
    if (msg.Event === "unsubscribe") {
      // Optional: revoke bindings for this openid — P1.5
      return new Response("success", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    return new Response("success", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  if (msg.MsgType !== "text") {
    return wechatTextReply(msg, "请发送系统中生成的绑定码。");
  }

  const content = String(msg.Content || "").trim().toUpperCase();
  // Accept 5–8 alnum codes (exclude ambiguous handled by generator)
  if (!/^[0-9A-Z]{5,8}$/.test(content)) {
    return wechatTextReply(msg, "请发送系统中生成的绑定码（5–8 位字母数字）。");
  }

  const result = await consumeBindCode(env.kv, env.db, {
    code: content,
    openid,
    channel: "wechat_oa"
  });

  if (!result.ok) {
    return wechatTextReply(msg, result.error === "openid already bound to another user"
      ? "该微信已绑定其他账号，请先解绑。"
      : `绑定失败：${result.error || "无效或过期的绑定码"}`);
  }

  if (result.purpose === "wechat_login") {
    return wechatTextReply(msg, "发码登录功能暂未开放，请使用账号密码登录后再绑定通知。");
  }

  return wechatTextReply(msg, "绑定成功！您将可以收到系统通知。");
}
