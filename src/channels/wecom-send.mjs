const MAX_EGRESS_RESPONSE_BYTES = 64 * 1024;
const textEncoder = new TextEncoder();
import { sliceByBytes } from "./text-bytes.mjs";

function isSingleWecomUserId(value) {
  return Boolean(value)
    && textEncoder.encode(value).byteLength <= 64
    && !value.includes("|")
    && value.toLowerCase() !== "@all"
    && !/[\u0000-\u001f\u007f]/.test(value);
}

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

export async function sendWecomApplicationMessage(
  env,
  { userId, title, body, url, deliveryId }
) {
  const target = String(userId || "").trim();
  if (!isSingleWecomUserId(target)) {
    return {
      ok: false,
      retryable: false,
      outcomeUnknown: false,
      errorCode: "wecom_invalid_target",
      error: "WeCom target must be one bound user"
    };
  }
  const base = String(env.EGRESS_BASE_URL || "").replace(/\/+$/, "");
  if (!base) return { ok: false, retryable: false, error: "EGRESS_BASE_URL is not configured" };
  if (!env.EGRESS_SHARED_SECRET) {
    return { ok: false, retryable: false, error: "EGRESS_SHARED_SECRET is not configured" };
  }

  const payload = url
    ? {
        userId: target,
        msgType: "textcard",
        title: String(title || "通知").slice(0, 128),
        description: String(body || "-").slice(0, 1000),
        url: String(url)
      }
    : {
        userId: target,
        msgType: "markdown",
        content: sliceByBytes(
          `**${String(title || "通知").trim()}**\n\n${String(body || "").trim()}`,
          2048
        )
      };

  let response;
  try {
    response = await fetch(`${base}/wecom/app/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Egress-Key": env.EGRESS_SHARED_SECRET,
        ...(deliveryId ? { "X-Delivery-Id": deliveryId } : {})
      },
      signal: AbortSignal.timeout(Number(env.EGRESS_TIMEOUT_MS || 10_000)),
      body: JSON.stringify(payload)
    });
  } catch (error) {
    return {
      ok: false,
      retryable: true,
      outcomeUnknown: true,
      errorCode: "egress_network_error",
      error: `egress network error: ${error?.message || error}`
    };
  }

  let result = {};
  try {
    const text = await readLimitedText(response);
    result = text ? JSON.parse(text) : {};
  } catch (error) {
    return {
      ok: false,
      retryable: true,
      outcomeUnknown: false,
      errorCode: "invalid_egress_response",
      error: String(error?.message || error)
    };
  }
  if (!response.ok || result.ok === false) {
    return {
      ok: false,
      retryable: response.status === 429 || response.status >= 500 || result.errcode === -1,
      outcomeUnknown: false,
      errorCode: result.errcode != null
        ? `wecom_${result.errcode}`
        : response.status === 429
          ? "provider_rate_limited"
          : `provider_http_${response.status}`,
      error: result.error || result.errmsg || `egress HTTP ${response.status}`,
      providerMsgId: result.msgid || null
    };
  }
  return { ok: true, providerMsgId: result.msgid || null };
}
