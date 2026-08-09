/**
 * WeChat Official Account API client for the fixed-IP egress gateway.
 *
 * Mirrors wecom-client.mjs: caches access_token, refreshes once on token
 * errors (40001/40014/42001), and classifies provider errors.
 */

const MAX_RESPONSE_BYTES = 64 * 1024;
const TOKEN_ERROR_CODES = new Set([40001, 40014, 42001]);
const PERMANENT_ERROR_CODES = new Set([40003, 40013, 43004, 45015, 48001]);

async function readLimitedJson(response) {
  const declared = Number(response.headers.get("Content-Length") || 0);
  if (declared > MAX_RESPONSE_BYTES) throw new Error("WeChat response is too large");
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
      throw new Error("WeChat response is too large");
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text ? JSON.parse(text) : {};
}

function providerError(data) {
  const errcode = Number(data.errcode);
  const error = new Error(data.errmsg || `wechat errcode ${errcode}`);
  error.errcode = errcode;
  if (errcode === -1) error.statusCode = 503;
  else if (errcode === 45009) error.statusCode = 429;
  else if (errcode === 48001) error.statusCode = 403;
  else if (TOKEN_ERROR_CODES.has(errcode)) error.statusCode = 503;
  else if (PERMANENT_ERROR_CODES.has(errcode)) error.statusCode = 422;
  else error.statusCode = 502;
  return error;
}

export function createWechatClient({
  appId,
  appSecret,
  fetchImpl = fetch,
  timeoutMs = 10_000
}) {
  let tokenCache = { accessToken: null, expiresAt: 0 };

  async function getAccessToken(forceRefresh = false) {
    if (!forceRefresh && tokenCache.accessToken && Date.now() < tokenCache.expiresAt - 60_000) {
      return tokenCache.accessToken;
    }
    if (!appId || !appSecret) throw new Error("WECHAT_APP_ID/SECRET not configured");
    const url =
      `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential` +
      `&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(appSecret)}`;
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    const data = await readLimitedJson(response);
    if (!response.ok || !data.access_token) {
      throw providerError(data.errcode ? data : { errmsg: "failed to get access_token" });
    }
    tokenCache = {
      accessToken: data.access_token,
      expiresAt: Date.now() + (Number(data.expires_in) || 7200) * 1000
    };
    return tokenCache.accessToken;
  }

  async function callApi(path, payload, retried = false) {
    const accessToken = await getAccessToken(retried);
    const response = await fetchImpl(
      `https://api.weixin.qq.com${path}?access_token=${encodeURIComponent(accessToken)}`,
      {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }
    );
    const data = await readLimitedJson(response);
    if (data.errcode && data.errcode !== 0) {
      if (TOKEN_ERROR_CODES.has(Number(data.errcode)) && !retried) {
        tokenCache = { accessToken: null, expiresAt: 0 };
        return callApi(path, payload, true);
      }
      throw providerError(data);
    }
    return data;
  }

  return { getAccessToken, callApi };
}
