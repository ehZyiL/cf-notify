/**
 * Outbound WeChat send via fixed-IP egress gateway.
 *
 * Env:
 *   EGRESS_BASE_URL
 *   EGRESS_SHARED_SECRET
 */

export async function sendWechatTemplate(env, { openid, templateId, data, url }) {
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
        "X-Egress-Key": env.EGRESS_SHARED_SECRET
      },
      body: JSON.stringify({
        openid,
        template_id: templateId,
        data: data || {},
        url: url || undefined
      })
    });
  } catch (e) {
    return { ok: false, error: `egress network error: ${e && e.message ? e.message : e}` };
  }

  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text.slice(0, 200) };
  }

  if (!res.ok || body.ok === false) {
    return {
      ok: false,
      error: body.error || body.errmsg || `egress HTTP ${res.status}`,
      providerMsgId: body.msgid || body.msg_id || null
    };
  }

  return {
    ok: true,
    providerMsgId: body.msgid || body.msg_id || body.data?.msgid || null
  };
}
