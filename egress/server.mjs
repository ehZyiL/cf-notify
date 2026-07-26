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

const PORT = Number(process.env.PORT || 8789);
const APP_ID = process.env.WECHAT_APP_ID || "";
const APP_SECRET = process.env.WECHAT_APP_SECRET || "";
const SHARED = process.env.EGRESS_SHARED_SECRET || "";

let tokenCache = { accessToken: null, expiresAt: 0 };
const MAX_BODY_BYTES = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;

function sameSecret(provided, expected) {
  const left = createHash("sha256").update(String(provided || "")).digest();
  const right = createHash("sha256").update(String(expected || "")).digest();
  return timingSafeEqual(left, right);
}

async function getAccessToken() {
  if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.accessToken;
  }
  if (!APP_ID || !APP_SECRET) throw new Error("WECHAT_APP_ID/SECRET not configured");
  const url =
    `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential` +
    `&appid=${encodeURIComponent(APP_ID)}&secret=${encodeURIComponent(APP_SECRET)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(data.errmsg || "failed to get access_token");
  }
  tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 7200) * 1000
  };
  return tokenCache.accessToken;
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
      const accessToken = await getAccessToken();
      const wxRes = await fetch(
        `https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=${accessToken}`,
        {
          method: "POST",
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            touser: openid,
            template_id: templateId,
            url: input.url || undefined,
            data: input.data || {}
          })
        }
      );
      const wxData = await wxRes.json();
      if (wxData.errcode && wxData.errcode !== 0) {
        return sendJson(res, 502, {
          ok: false,
          error: wxData.errmsg || `wechat errcode ${wxData.errcode}`,
          errcode: wxData.errcode
        });
      }
      return sendJson(res, 200, { ok: true, msgid: wxData.msgid });
    } catch (e) {
      return sendJson(res, e?.statusCode || 500, {
        ok: false,
        error: e && e.message ? e.message : String(e)
      });
    }
  }

  sendJson(res, 404, { ok: false, error: "not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`wechat-egress listening on 0.0.0.0:${PORT}`);
});
