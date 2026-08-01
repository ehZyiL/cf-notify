const CHANNEL_METADATA = Object.freeze({
  wechat_oa: {
    displayName: "微信公众号",
    implemented: true,
    eyebrow: "WeChat Official Account",
    accountLabel: "微信账号",
    emptyTitle: "尚未绑定公众号",
    emptyDescription: "绑定后可通过公众号接收业务提醒。",
    readyTitle: "公众号通知已就绪",
    readyDescription: "当前账号可以接收公众号通知。",
    openStep: "在微信中打开并关注通知公众号。",
    sendStep: "将绑定码原样发送给公众号。"
  },
  wecom: {
    displayName: "企业微信",
    implemented: true,
    eyebrow: "WeCom",
    accountLabel: "企业微信账号",
    emptyTitle: "尚未绑定企业微信",
    emptyDescription: "绑定后可通过企业微信应用接收业务提醒。",
    readyTitle: "企业微信通知已就绪",
    readyDescription: "当前账号可以接收企业微信应用通知。",
    openStep: "在企业微信中打开通知应用。",
    sendStep: "将绑定码原样发送给应用。"
  },
  telegram: {
    displayName: "Telegram",
    implemented: false,
    eyebrow: "Telegram",
    accountLabel: "Telegram 账号",
    emptyTitle: "尚未绑定 Telegram",
    emptyDescription: "绑定后可通过 Telegram 机器人接收业务提醒。",
    readyTitle: "Telegram 通知已就绪",
    readyDescription: "当前账号可以接收 Telegram 通知。",
    openStep: "在 Telegram 中打开通知机器人。",
    sendStep: "将绑定码原样发送给机器人。"
  }
});

// Fallback copy for channels that are not yet registered as adapters. Keeps the
// account-center binding UI renderable (never empty) for any surfaced channel.
const GENERIC_METADATA = Object.freeze({
  displayName: "未知渠道",
  implemented: false,
  eyebrow: "Notification Channel",
  accountLabel: "渠道账号",
  emptyTitle: "尚未绑定渠道",
  emptyDescription: "绑定后可通过该渠道接收业务提醒。",
  readyTitle: "渠道通知已就绪",
  readyDescription: "当前账号可以接收该渠道通知。",
  openStep: "打开对应应用或服务。",
  sendStep: "将绑定码原样发送给对方。"
});

function configured(value) {
  return Boolean(String(value || "").trim());
}

function safeHttpsUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "https:" && !parsed.username && !parsed.password
      ? parsed.toString()
      : "";
  } catch {
    return "";
  }
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

function defaultProviderAccountId(env, channel) {
  if (channel === "wechat_oa") {
    return String(env.WECHAT_PROVIDER_ACCOUNT_ID || env.WECHAT_APP_ID || "default");
  }
  if (channel === "wecom") {
    return String(env.WECOM_PROVIDER_ACCOUNT_ID || "wecom-main");
  }
  return null;
}

export function getChannelCapability(env, guide) {
  const channel = String(guide?.channel || "");
  const metadata = CHANNEL_METADATA[channel] || GENERIC_METADATA;
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
    // Binding flow copy + default provider account, consumed by the cf-auth
    // account center so it renders purely from channel data.
    providerAccountId: defaultProviderAccountId(env, channel),
    eyebrow: metadata.eyebrow,
    accountLabel: metadata.accountLabel,
    emptyTitle: metadata.emptyTitle,
    emptyDescription: metadata.emptyDescription,
    readyTitle: metadata.readyTitle,
    readyDescription: metadata.readyDescription,
    openStep: metadata.openStep,
    sendStep: metadata.sendStep,
    // Guide links used by the account-center binding flow.
    accountName: String(guide?.accountName || "").trim(),
    description: String(guide?.description || "").trim(),
    imageUrl: safeHttpsUrl(guide?.imageUrl),
    actionUrl: safeHttpsUrl(guide?.actionUrl),
    actionLabel: String(guide?.actionLabel || "").trim(),
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
