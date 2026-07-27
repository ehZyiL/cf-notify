import { HttpError } from "./http.mjs";

const GUIDE_KEY_PREFIX = "channel-guide:v1:";

const CHANNEL_DEFAULTS = {
  wechat_oa: {
    displayName: "微信公众号",
    accountName: "",
    description: "扫码关注公众号后，将绑定码原样发送给公众号。",
    actionLabel: "打开公众号"
  },
  wecom: {
    displayName: "企业微信",
    accountName: "",
    description: "扫码加入企业后，在企业微信中打开通知应用并发送绑定码。",
    actionLabel: "打开企业微信"
  },
  telegram: {
    displayName: "Telegram",
    accountName: "",
    description: "打开通知机器人后发送绑定码。",
    actionLabel: "打开 Telegram"
  }
};

export const CHANNEL_GUIDE_CHANNELS = Object.freeze(Object.keys(CHANNEL_DEFAULTS));

function guideKey(channel) {
  return `${GUIDE_KEY_PREFIX}${channel}`;
}

function text(value, maxLength) {
  const normalized = String(value ?? "").trim();
  if (normalized.length > maxLength) {
    throw new HttpError(400, `channel guide field exceeds ${maxLength} characters`);
  }
  return normalized;
}

function httpsUrl(value, field) {
  const normalized = text(value, 2048);
  if (!normalized) return "";
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new HttpError(400, `${field} must be a valid HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new HttpError(400, `${field} must be a valid HTTPS URL`);
  }
  return parsed.toString();
}

function envGuide(env, channel) {
  const defaults = CHANNEL_DEFAULTS[channel];
  if (!defaults) {
    throw new HttpError(400, "notification channel is not supported");
  }
  const configured = {
    wechat_oa: {
      accountName: env.WECHAT_ACCOUNT_NAME,
      imageUrl: env.WECHAT_QRCODE_URL,
      actionUrl: env.WECHAT_ACCOUNT_URL
    },
    wecom: {
      accountName: env.WECOM_ACCOUNT_NAME,
      imageUrl: env.WECOM_QRCODE_URL,
      actionUrl: env.WECOM_APP_URL
    },
    telegram: {
      accountName: env.TELEGRAM_BOT_NAME,
      imageUrl: env.TELEGRAM_QRCODE_URL,
      actionUrl: env.TELEGRAM_BOT_URL
    }
  }[channel];

  return {
    channel,
    enabled: channel !== "telegram" && Boolean(configured.imageUrl || configured.actionUrl),
    displayName: defaults.displayName,
    accountName: String(configured.accountName || "").trim(),
    description: defaults.description,
    imageUrl: String(configured.imageUrl || "").trim(),
    actionUrl: String(configured.actionUrl || "").trim(),
    actionLabel: defaults.actionLabel,
    updatedAt: null,
    source: "env"
  };
}

function normalizeGuide(channel, input, fallback) {
  if (!CHANNEL_DEFAULTS[channel]) {
    throw new HttpError(400, "notification channel is not supported");
  }
  const value = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return {
    channel,
    enabled: value.enabled == null ? Boolean(fallback.enabled) : Boolean(value.enabled),
    displayName: text(value.displayName ?? fallback.displayName, 80),
    accountName: text(value.accountName ?? fallback.accountName, 120),
    description: text(value.description ?? fallback.description, 300),
    imageUrl: httpsUrl(value.imageUrl ?? fallback.imageUrl, "imageUrl"),
    actionUrl: httpsUrl(value.actionUrl ?? fallback.actionUrl, "actionUrl"),
    actionLabel: text(value.actionLabel ?? fallback.actionLabel, 40),
    updatedAt: value.updatedAt || fallback.updatedAt || null,
    source: value.source || fallback.source || "env"
  };
}

async function getStoredGuide(kv, channel) {
  if (!kv) return null;
  try {
    const raw = await kv.get(guideKey(channel));
    if (!raw) return null;
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export async function listChannelGuides(env, options = {}) {
  const guides = await Promise.all(CHANNEL_GUIDE_CHANNELS.map(async (channel) => {
    const fallback = envGuide(env, channel);
    const stored = await getStoredGuide(env.kv, channel);
    return stored
      ? normalizeGuide(channel, { ...stored, source: "kv" }, fallback)
      : normalizeGuide(channel, fallback, fallback);
  }));
  return options.includeDisabled ? guides : guides.filter((guide) => guide.enabled);
}

export async function saveChannelGuide(env, channel, input) {
  if (!env.kv) throw new HttpError(503, "channel guide storage is unavailable");
  const fallback = envGuide(env, channel);
  const current = await getStoredGuide(env.kv, channel);
  const guide = normalizeGuide(channel, {
    ...(current || {}),
    ...(input || {}),
    updatedAt: new Date().toISOString(),
    source: "kv"
  }, fallback);
  await env.kv.put(guideKey(channel), JSON.stringify(guide));
  return guide;
}

export async function resetChannelGuide(env, channel) {
  if (!CHANNEL_DEFAULTS[channel]) {
    throw new HttpError(400, "notification channel is not supported");
  }
  if (!env.kv) throw new HttpError(503, "channel guide storage is unavailable");
  await env.kv.delete(guideKey(channel));
  const fallback = envGuide(env, channel);
  return normalizeGuide(channel, fallback, fallback);
}
