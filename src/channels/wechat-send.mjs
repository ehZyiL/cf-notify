/**
 * Outbound WeChat send via fixed-IP egress gateway.
 *
 * Env:
 *   EGRESS_BASE_URL
 *   EGRESS_SHARED_SECRET
 */

const MAX_EGRESS_RESPONSE_BYTES = 64 * 1024;

async function readLimitedText(response) {
  const declared = Number(response.headers.get("Content-Length") || 0);
  if (declared > MAX_EGRESS_RESPONSE_BYTES) throw new Error("egress response is too large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_EGRESS_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("egress response is too large");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export async function sendWechatTemplate(env, { openid, templateId, data, url, deliveryId }) {
  const base = String(env.EGRESS_BASE_URL || "").replace(/\/+$/, "");
  if (!base) {
    return { ok: false, error: "EGRESS_BASE_URL is not configured" };
  }
  if (!env.EGRESS_SHARED_SECRET) {
    return { ok: false, error: "EGRESS_SHARED_SECRET is not configured" };
  }

  const endpoint = `${base}/wechat/template/send`;
  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Egress-Key": env.EGRESS_SHARED_SECRET,
        ...(deliveryId ? { "X-Delivery-Id": deliveryId } : {})
      },
      signal: AbortSignal.timeout(Number(env.EGRESS_TIMEOUT_MS || 10_000)),
      body: JSON.stringify({
        openid,
        template_id: templateId,
        data: data || {},
        url: url || undefined
      })
    });
  } catch (e) {
    return {
      ok: false,
      retryable: true,
      outcomeUnknown: true,
      errorCode: "egress_network_error",
      error: `egress network error: ${e && e.message ? e.message : e}`
    };
  }

  let text;
  try {
    text = await readLimitedText(res);
  } catch (error) {
    return {
      ok: false,
      retryable: true,
      outcomeUnknown: false,
      errorCode: "invalid_egress_response",
      error: String(error?.message || error)
    };
  }
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text.slice(0, 200) };
  }

  if (!res.ok || body.ok === false) {
    const retryable = res.status === 429 || res.status >= 500 || body.errcode === -1;
    return {
      ok: false,
      retryable,
      outcomeUnknown: false,
      errorCode: res.status === 429 ? "provider_rate_limited" : `provider_http_${res.status}`,
      error: body.error || body.errmsg || `egress HTTP ${res.status}`,
      providerMsgId: body.msgid || body.msg_id || null
    };
  }

  return {
    ok: true,
    providerMsgId: body.msgid || body.msg_id || body.data?.msgid || null
  };
}
