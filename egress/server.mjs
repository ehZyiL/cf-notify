/**
 * Minimal WeChat egress gateway for fixed public IP hosts.
 *
 * Env:
 *   WECHAT_APP_ID
 *   WECHAT_APP_SECRET
 *   EGRESS_SHARED_SECRET
 *   PORT (default 8789)
 *
 * Run: node egress/server.mjs
 * Put this host's public IP in WeChat IP whitelist.
 */

import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { createWecomClient } from "./wecom-client.mjs";
import { createWechatClient } from "./wechat-client.mjs";

const PORT = Number(process.env.PORT || 8789);
const APP_ID = process.env.WECHAT_APP_ID || "";
const APP_SECRET = process.env.WECHAT_APP_SECRET || "";
const SHARED = process.env.EGRESS_SHARED_SECRET || "";
const WECOM_CLIENT = createWecomClient({
  corpId: process.env.WECOM_CORP_ID || "",
  appSecret: process.env.WECOM_APP_SECRET || "",
  agentId: process.env.WECOM_AGENT_ID || ""
});
const WECHAT_CLIENT = createWechatClient({
  appId: APP_ID,
  appSecret: APP_SECRET
});

let tokenCache = { accessToken: null, expiresAt: 0 };
const MAX_BODY_BYTES = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;

function targetFingerprint(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

function sameSecret(provided, expected) {
  const left = createHash("sha256").update(String(provided || "")).digest();
  const right = createHash("sha256").update(String(expected || "")).digest();
  return timingSafeEqual(left, right);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let rejected = false;
    req.on("data", (chunk) => {
      if (rejected) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        rejected = true;
        const error = new Error("request body is too large");
        error.statusCode = 413;
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, { ok: true, service: "wechat-egress" });
  }

  const key = req.headers["x-egress-key"];
  if (!SHARED || !sameSecret(key, SHARED)) {
    return sendJson(res, 401, { ok: false, error: "unauthorized" });
  }

  if (req.method === "POST" && url.pathname === "/wechat/template/send") {
    try {
      const raw = await readBody(req);
      const input = JSON.parse(raw || "{}");
      const openid = input.openid;
      const templateId = input.template_id || input.templateId;
      if (!openid || !templateId) {
        return sendJson(res, 400, { ok: false, error: "openid and template_id required" });
      }
      const wxData = await WECHAT_CLIENT.callApi("/cgi-bin/message/template/send", {
        touser: openid,
        template_id: templateId,
        url: input.url || undefined,
        data: input.data || {}
      });
      return sendJson(res, 200, { ok: true, msgid: wxData.msgid });
    } catch (e) {
      return sendJson(res, e?.statusCode || 500, {
        ok: false,
        error: e && e.message ? e.message : String(e),
        ...(e?.errcode != null ? { errcode: e.errcode } : {})
      });
    }
  }

  if (req.method === "POST" && url.pathname === "/wechat/custom/send") {
    let targetHash = null;
    try {
      const raw = await readBody(req);
      const input = JSON.parse(raw || "{}");
      const openid = String(input.openid || "").trim();
      const text = String(input.text || "").trim();
      if (!openid || !text) {
        return sendJson(res, 400, { ok: false, error: "openid and text required" });
      }
      if (text.length > 2000) {
        return sendJson(res, 400, { ok: false, error: "text is too long" });
      }
      targetHash = targetFingerprint(openid);
      const wxData = await WECHAT_CLIENT.callApi("/cgi-bin/message/custom/send", {
        touser: openid,
        msgtype: "text",
        text: { content: text }
      });
      console.log(JSON.stringify({
        event: "wechat_custom_send",
        deliveryId: req.headers["x-delivery-id"] || null,
        targetHash,
        ok: true
      }));
      return sendJson(res, 200, { ok: true, msgid: wxData.msgid || null });
    } catch (e) {
      console.error(JSON.stringify({
        event: "wechat_custom_send",
        deliveryId: req.headers["x-delivery-id"] || null,
        targetHash,
        ok: false,
        errcode: e?.errcode ?? null,
        error: String(e?.message || e).slice(0, 300)
      }));
      return sendJson(res, e?.statusCode || 500, {
        ok: false,
        error: e && e.message ? e.message : String(e),
        ...(e?.errcode != null ? { errcode: e.errcode } : {})
      });
    }
  }

  if (req.method === "POST" && url.pathname === "/wecom/app/send") {
    let targetHash = null;
    try {
      const raw = await readBody(req);
      const input = JSON.parse(raw || "{}");
      targetHash = targetFingerprint(input.userId);
      const result = await WECOM_CLIENT.sendApplicationMessage(input);
      console.log(JSON.stringify({
        event: "wecom_app_send",
        deliveryId: req.headers["x-delivery-id"] || null,
        targetHash,
        ok: true
      }));
      return sendJson(res, 200, { ok: true, msgid: result.msgid || null });
    } catch (e) {
      console.error(JSON.stringify({
        event: "wecom_app_send",
        deliveryId: req.headers["x-delivery-id"] || null,
        targetHash,
        ok: false,
        errcode: e?.errcode ?? null,
        error: String(e?.message || e).slice(0, 300)
      }));
      return sendJson(res, e?.statusCode || 500, {
        ok: false,
        error: e?.message || String(e),
        ...(e?.errcode != null ? { errcode: e.errcode } : {})
      });
    }
  }

  sendJson(res, 404, { ok: false, error: "not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`wechat-egress listening on 0.0.0.0:${PORT}`);
});
