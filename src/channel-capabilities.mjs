const CHANNEL_METADATA = Object.freeze({
  wechat_oa: {
    displayName: "微信公众号",
    implemented: true
  },
  wecom: {
    displayName: "企业微信",
    implemented: true
  },
  telegram: {
    displayName: "Telegram",
    implemented: false
  }
});

function configured(value) {
  return Boolean(String(value || "").trim());
}

function callbackConfigured(env, channel) {
  if (channel === "wechat_oa") return configured(env.WECHAT_TOKEN);
  if (channel === "wecom") {
    return configured(env.WECOM_CALLBACK_TOKEN)
      && configured(env.WECOM_ENCODING_AES_KEY)
      && configured(env.WECOM_CORP_ID);
  }
  return false;
}

function deliveryConfiguration(env, channel) {
  const egressConfigured = configured(env.EGRESS_BASE_URL) && configured(env.EGRESS_SHARED_SECRET);
  if (channel === "wechat_oa") {
    const mode = String(env.WECHAT_SEND_MODE || "template").trim().toLowerCase();
    return {
      configured: egressConfigured && ["custom_text", "template"].includes(mode),
      mode,
      limitations: mode === "custom_text" ? ["interaction_window_required"] : []
    };
  }
  if (channel === "wecom") {
    return { configured: egressConfigured, mode: "application_message", limitations: [] };
  }
  return { configured: false, mode: null, limitations: [] };
}

function statusFor({ implemented, enrollmentEnabled, callbackReady, deliveryReady, mode }) {
  if (!implemented) return { status: "unavailable", reason: "not_implemented" };
  if (!enrollmentEnabled) return { status: "disabled", reason: "guide_disabled" };
  if (!callbackReady) return { status: "degraded", reason: "callback_not_configured" };
  if (!deliveryReady) {
    return {
      status: "degraded",
      reason: mode && !["custom_text", "template", "application_message"].includes(mode)
        ? "unsupported_send_mode"
        : "egress_not_configured"
    };
  }
  return { status: "ready", reason: null };
}

export function getChannelCapability(env, guide) {
  const channel = String(guide?.channel || "");
  const metadata = CHANNEL_METADATA[channel] || {
    displayName: channel || "未知渠道",
    implemented: false
  };
  const enrollmentEnabled = Boolean(guide?.enabled);
  const callbackReady = callbackConfigured(env, channel);
  const delivery = deliveryConfiguration(env, channel);
  const state = statusFor({
    implemented: metadata.implemented,
    enrollmentEnabled,
    callbackReady,
    deliveryReady: delivery.configured,
    mode: delivery.mode
  });
  return {
    channel,
    displayName: String(guide?.displayName || metadata.displayName),
    implemented: metadata.implemented,
    enrollmentEnabled,
    callbackConfigured: callbackReady,
    deliveryConfigured: delivery.configured,
    bindable: metadata.implemented && enrollmentEnabled && callbackReady,
    sendable: metadata.implemented && delivery.configured,
    available: state.status === "ready",
    status: state.status,
    reason: state.reason,
    mode: delivery.mode,
    limitations: delivery.limitations,
    guideSource: guide?.source || null,
    updatedAt: guide?.updatedAt || null
  };
}

export function listChannelCapabilities(env, guides) {
  return (guides || []).map((guide) => getChannelCapability(env, guide));
}

export function capabilityReasonMessage(reason) {
  return {
    not_implemented: "该渠道尚未实现投递适配器",
    guide_disabled: "该渠道尚未对用户开放",
    callback_not_configured: "渠道回调配置不完整",
    egress_not_configured: "固定出口网关配置不完整",
    unsupported_send_mode: "公众号发送模式不受支持"
  }[reason] || "渠道尚未就绪";
}
