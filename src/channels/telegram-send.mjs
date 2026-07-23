/**
 * Telegram adapter stub (Phase 2).
 * Env when implemented: TELEGRAM_BOT_TOKEN
 */

export async function sendTelegram(_env, { chatId, text }) {
  if (!chatId) return { ok: false, error: "chatId required" };
  return {
    ok: false,
    error: "telegram_not_implemented",
    detail: text ? String(text).slice(0, 40) : null
  };
}
