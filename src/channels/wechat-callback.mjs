import { sha1Hex, timingSafeEqual } from "../crypto.mjs";
import { consumeBindCode } from "../bindings.mjs";
import { assertOpenidCodeAttemptAllowed } from "../rate-limit.mjs";
import { wechatDecrypt, wechatEncrypt } from "./wechat-crypto.mjs";

/**
 * WeChat server URL verification (GET).
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

async function revokeByOpenid(db, openid, channel = "wechat_oa") {
  if (!db || !openid) return;
  await db
    .prepare(
      `UPDATE channel_bindings SET status = 'revoked', updated_at = ?
       WHERE channel = ? AND external_id = ? AND status = 'verified'`
    )
    .bind(new Date().toISOString(), channel, openid)
    .run();
}

/**
 * Handle inbound WeChat message: bind code flow.
 * Supports plaintext XML; if Encrypt node present and AES key set, decrypt first.
 */
export async function handleWechatMessage(env, xmlBody) {
  let xml = xmlBody;
  const outer = parseWechatXml(xmlBody);
  if (outer.Encrypt && env.WECHAT_AES_KEY && env.WECHAT_APP_ID) {
    try {
      xml = await wechatDecrypt(outer.Encrypt, env.WECHAT_AES_KEY, env.WECHAT_APP_ID);
    } catch (e) {
      console.error("wechat decrypt failed", e && e.message);
      return new Response("success", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
  }

  const msg = parseWechatXml(xml);
  const openid = msg.FromUserName;
  if (!openid) {
    return new Response("success", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  const reply = async (content) => {
    const plain = wechatTextReply(msg, content);
    // If request was encrypted, encrypt reply when keys present
    if (outer.Encrypt && env.WECHAT_AES_KEY && env.WECHAT_APP_ID) {
      const plainXml = await plain.text();
      try {
        const encrypt = await wechatEncrypt(plainXml, env.WECHAT_AES_KEY, env.WECHAT_APP_ID);
        const now = Math.floor(Date.now() / 1000);
        const packed = `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt><MsgSignature><![CDATA[]]></MsgSignature><TimeStamp>${now}</TimeStamp><Nonce><![CDATA[stub]]></Nonce></xml>`;
        // Note: full msg_signature for encrypted reply needs token+timestamp+nonce+encrypt sha1 — simplified for P1.5 tests of decrypt path
        return new Response(packed, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
      } catch {
        return plain;
      }
    }
    return plain;
  };

  if (msg.MsgType === "event") {
    if (msg.Event === "subscribe") {
      return reply("感谢关注。请在业务系统中生成绑定码，并发送给本公众号完成通知绑定。");
    }
    if (msg.Event === "unsubscribe") {
      await revokeByOpenid(env.db, openid, "wechat_oa");
      return new Response("success", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    return new Response("success", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  if (msg.MsgType !== "text") {
    return reply("请发送系统中生成的绑定码。");
  }

  const content = String(msg.Content || "").trim().toUpperCase();
  if (!/^[0-9A-Z]{5,8}$/.test(content)) {
    return reply("请发送系统中生成的绑定码（5–8 位字母数字）。");
  }

  const attempt = await assertOpenidCodeAttemptAllowed(env.kv, openid);
  if (!attempt.allowed) {
    return reply("尝试次数过多，请稍后再试。");
  }

  const result = await consumeBindCode(env.kv, env.db, {
    code: content,
    openid,
    channel: "wechat_oa"
  });

  if (!result.ok) {
    return reply(
      result.error === "openid already bound to another user"
        ? "该微信已绑定其他账号，请先解绑。"
        : `绑定失败：${result.error || "无效或过期的绑定码"}`
    );
  }

  if (result.purpose === "wechat_login") {
    return reply("发码登录功能暂未开放，请使用账号密码登录后再绑定通知。");
  }

  return reply("绑定成功！您将可以收到系统通知。");
}
