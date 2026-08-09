const MAX_RESPONSE_BYTES = 64 * 1024;
const TOKEN_ERROR_CODES = new Set([40001, 40014, 42001]);
const PERMANENT_ERROR_CODES = new Set([40013, 40056, 40058, 60111, 81013, 301002]);
const textEncoder = new TextEncoder();

import { sliceByBytes, byteLength } from "./text-bytes.mjs";

function isSingleWecomUserId(value) {
  return Boolean(value)
    && textEncoder.encode(value).byteLength <= 64
    && !value.includes("|")
    && value.toLowerCase() !== "@all"
    && !/[\u0000-\u001f\u007f]/.test(value);
}

async function readLimitedJson(response) {
  const declared = Number(response.headers.get("Content-Length") || 0);
  if (declared > MAX_RESPONSE_BYTES) throw new Error("WeCom response is too large");
  if (!response.body) return {};
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("WeCom response is too large");
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text ? JSON.parse(text) : {};
}

function providerError(data) {
  const error = new Error(data.errmsg || `WeCom errcode ${data.errcode}`);
  error.errcode = Number(data.errcode);
  if (error.errcode === -1) error.statusCode = 503;
  else if (error.errcode === 45009) error.statusCode = 429;
  else if (PERMANENT_ERROR_CODES.has(error.errcode)) error.statusCode = 422;
  else error.statusCode = 502;
  return error;
}

export function createWecomClient({
  corpId,
  appSecret,
  agentId,
  fetchImpl = fetch,
  timeoutMs = 10_000
}) {
  let tokenCache = { accessToken: null, expiresAt: 0 };

  async function getAccessToken(forceRefresh = false) {
    if (!forceRefresh && tokenCache.accessToken && Date.now() < tokenCache.expiresAt - 60_000) {
      return tokenCache.accessToken;
    }
    if (!corpId || !appSecret) throw new Error("WECOM_CORP_ID/APP_SECRET not configured");
    const response = await fetchImpl(
      `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}`
        + `&corpsecret=${encodeURIComponent(appSecret)}`,
      { signal: AbortSignal.timeout(timeoutMs) }
    );
    const data = await readLimitedJson(response);
    if (!response.ok || !data.access_token || Number(data.errcode || 0) !== 0) {
      throw providerError(data);
    }
    tokenCache = {
      accessToken: data.access_token,
      expiresAt: Date.now() + (Number(data.expires_in) || 7200) * 1000
    };
    return tokenCache.accessToken;
  }

  async function callMessageApi(payload, retried = false) {
    const accessToken = await getAccessToken(retried);
    const response = await fetchImpl(
      `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`,
      {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }
    );
    const data = await readLimitedJson(response);
    if (TOKEN_ERROR_CODES.has(Number(data.errcode)) && !retried) {
      tokenCache = { accessToken: null, expiresAt: 0 };
      return callMessageApi(payload, true);
    }
    if (!response.ok || Number(data.errcode || 0) !== 0) throw providerError(data);
    if (String(data.invaliduser || "").trim()) {
      const error = new Error("WeCom user is invalid or outside the application visibility range");
      error.errcode = 60111;
      error.statusCode = 422;
      throw error;
    }
    return data;
  }

  async function sendApplicationMessage(input) {
    const userId = String(input.userId || "").trim();
    if (!isSingleWecomUserId(userId)) {
      const error = new Error("one WeCom userId is required");
      error.statusCode = 400;
      throw error;
    }
    const msgType = String(input.msgType || "text").toLowerCase();
    let content;
    if (msgType === "text") {
      const text = String(input.content || "").trim();
      if (!text || byteLength(text) > 2048) {
        throw Object.assign(new Error("invalid text content"), { statusCode: 400 });
      }
      content = { text: { content: sliceByBytes(text, 2048) } };
    } else if (msgType === "markdown") {
      const text = String(input.content || "").trim();
      if (!text || byteLength(text) > 2048) {
        throw Object.assign(new Error("invalid markdown content"), { statusCode: 400 });
      }
      content = { markdown: { content: sliceByBytes(text, 2048) } };
    } else if (msgType === "textcard") {
      const title = String(input.title || "").trim();
      const description = String(input.description || "").trim();
      let url;
      try {
        url = new URL(String(input.url || ""));
        if (url.protocol !== "https:") throw new Error("not https");
      } catch {
        throw Object.assign(new Error("valid HTTPS textcard URL is required"), { statusCode: 400 });
      }
      if (!title || !description) {
        throw Object.assign(new Error("textcard title and description are required"), { statusCode: 400 });
      }
      content = {
        textcard: {
          title: title.slice(0, 128),
          description: description.slice(0, 1000),
          url: url.toString(),
          btntxt: "查看详情"
        }
      };
    } else {
      throw Object.assign(new Error("unsupported WeCom message type"), { statusCode: 400 });
    }
    if (!agentId || !/^\d+$/.test(String(agentId))) {
      throw new Error("WECOM_AGENT_ID is not configured");
    }
    return callMessageApi({
      touser: userId,
      msgtype: msgType,
      agentid: Number(agentId),
      ...content,
      safe: 0,
      enable_id_trans: 0,
      enable_duplicate_check: 1,
      duplicate_check_interval: 1800
    });
  }

  return { getAccessToken, sendApplicationMessage };
}
