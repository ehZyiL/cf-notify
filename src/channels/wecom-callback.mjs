import { sha1Hex, sha256Hex, timingSafeEqual } from "../crypto.mjs";
import { HttpError } from "../http.mjs";
import { consumeNotificationBindingChallenge, usesNotificationDirectoryRpc } from "../notification-directory.mjs";
import { assertOpenidCodeAttemptAllowed } from "../rate-limit.mjs";
import { parseWechatXml, wechatTextReply } from "./wechat-callback.mjs";
import { wechatDecrypt, wechatEncrypt } from "./wechat-crypto.mjs";

export async function verifyWecomSignature(token, { msgSignature, timestamp, nonce, encrypt }) {
  if (!token || !msgSignature || !timestamp || !nonce || !encrypt) return false;
  const digest = await sha1Hex(
    [String(token), String(timestamp), String(nonce), String(encrypt)].sort().join("")
  );
  return timingSafeEqual(digest, String(msgSignature).toLowerCase());
}

export function isFreshWecomTimestamp(timestamp, options = {}) {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return false;
  const nowMs = options.now ?? Date.now();
  const maxSkewSec = options.maxSkewSec ?? 300;
  return Math.abs(nowMs - seconds * 1000) <= maxSkewSec * 1000;
}

async function callbackReceiptHash({ signature, timestamp, nonce, body }) {
  return sha256Hex(`${signature}\n${timestamp}\n${nonce}\n${body}`);
}

export async function claimWecomCallback(db, { signature, timestamp, nonce, body }) {
  const receiptHash = await callbackReceiptHash({ signature, timestamp, nonce, body });
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO wecom_callback_receipts (receipt_hash, received_at)
       VALUES (?, ?)`
    )
    .bind(receiptHash, Date.now())
    .run();
  return Number(result?.meta?.changes || 0) === 1;
}

export async function releaseWecomCallback(db, receipt) {
  const receiptHash = await callbackReceiptHash(receipt);
  await db
    .prepare("DELETE FROM wecom_callback_receipts WHERE receipt_hash = ?")
    .bind(receiptHash)
    .run();
}

export async function decryptWecomPayload(encrypted, env) {
  if (!env.WECOM_ENCODING_AES_KEY || !env.WECOM_CORP_ID) {
    throw new HttpError(503, "WeCom callback encryption is not configured");
  }
  try {
    return await wechatDecrypt(encrypted, env.WECOM_ENCODING_AES_KEY, env.WECOM_CORP_ID);
  } catch (error) {
    console.error(JSON.stringify({
      event: "wecom_callback_decrypt_failed",
      error: String(error?.message || error).slice(0, 300)
    }));
    throw new HttpError(403, "invalid WeCom encrypted payload");
  }
}

async function wecomTextReply(env, message, content) {
  const plainXml = await wechatTextReply(message, content).text();
  const encrypt = await wechatEncrypt(
    plainXml,
    env.WECOM_ENCODING_AES_KEY,
    env.WECOM_CORP_ID
  );
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const msgSignature = await sha1Hex(
    [String(env.WECOM_CALLBACK_TOKEN || ""), timestamp, nonce, encrypt].sort().join("")
  );
  const body = [
    "<xml>",
    `<Encrypt><![CDATA[${encrypt}]]></Encrypt>`,
    `<MsgSignature><![CDATA[${msgSignature}]]></MsgSignature>`,
    `<TimeStamp>${timestamp}</TimeStamp>`,
    `<Nonce><![CDATA[${nonce}]]></Nonce>`,
    "</xml>"
  ].join("");
  return new Response(body, {
    headers: { "Content-Type": "application/xml; charset=utf-8" }
  });
}

export async function handleWecomMessage(env, xmlBody) {
  const outer = parseWechatXml(xmlBody);
  if (!outer.Encrypt) throw new HttpError(400, "encrypted WeCom callback is required");
  const xml = await decryptWecomPayload(outer.Encrypt, env);
  const message = parseWechatXml(xml);
  const wecomUserId = String(message.FromUserName || "").trim();
  const code = String(message.Content || "").trim().toUpperCase();
  const looksLikeBindingCode = /^[0-9A-Z]{8}$/.test(code);
  console.log(JSON.stringify({
    event: "wecom_callback_message",
    msgType: String(message.MsgType || "").slice(0, 32),
    eventType: String(message.Event || "").slice(0, 64),
    hasSender: Boolean(wecomUserId),
    contentLength: code.length,
    looksLikeBindingCode
  }));
  if (!wecomUserId) return new Response("success");
  if (message.MsgType !== "text") {
    return new Response("success");
  }
  if (!looksLikeBindingCode) {
    return wecomTextReply(env, message, "绑定码格式不正确，请发送 8 位字母数字绑定码。");
  }
  const userFingerprint = await sha256Hex(wecomUserId);
  const attempt = await assertOpenidCodeAttemptAllowed(env.kv, `wecom:${userFingerprint}`);
  if (!attempt.allowed) {
    return wecomTextReply(env, message, "尝试次数过多，请稍后重新生成绑定码。");
  }
  if (!usesNotificationDirectoryRpc(env)) {
    throw new HttpError(409, "WeCom binding requires cf-auth notification directory RPC");
  }

  const result = await consumeNotificationBindingChallenge(env, {
    token: code,
    channel: "wecom",
    providerAccountId: env.WECOM_PROVIDER_ACCOUNT_ID || "wecom-main",
    externalIdentifier: wecomUserId,
    metadata: message.AgentID ? { agentId: String(message.AgentID).slice(0, 64) } : {}
  });
  console.log(JSON.stringify({
    event: "wecom_binding_callback",
    providerAccountId: env.WECOM_PROVIDER_ACCOUNT_ID || "wecom-main",
    ok: Boolean(result?.ok),
    error: result?.ok ? null : String(result?.error || "binding_failed").slice(0, 100)
  }));
  if (!result?.ok) {
    return wecomTextReply(env, message, "绑定失败，绑定码无效或已过期，请重新生成。");
  }
  return wecomTextReply(env, message, "绑定成功，企业微信通知已启用。");
}
