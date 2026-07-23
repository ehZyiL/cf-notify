import { createAppHandler } from "./app.mjs";

/**
 * Cloudflare Worker entry for cf-notify.
 *
 * Bindings: DB (D1), KV, ASSETS
 * Secrets: CF_AUTH_JWT_SECRET, WECHAT_TOKEN, EGRESS_BASE_URL, EGRESS_SHARED_SECRET,
 *          ADMIN_BOOTSTRAP_KEY (optional, create service clients)
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const isApi =
      path.startsWith("/api/") ||
      path.startsWith("/wechat/") ||
      path === "/health" ||
      path === "/healthz" ||
      path === "/api/health";

    if (isApi) {
      const runtime = {
        db: env.DB,
        kv: env.KV,
        CF_AUTH_JWT_SECRET: env.CF_AUTH_JWT_SECRET,
        CF_AUTH_JWT_AUDIENCE: env.CF_AUTH_JWT_AUDIENCE,
        WECHAT_TOKEN: env.WECHAT_TOKEN,
        WECHAT_AES_KEY: env.WECHAT_AES_KEY,
        WECHAT_APP_ID: env.WECHAT_APP_ID,
        WECHAT_QRCODE_URL: env.WECHAT_QRCODE_URL,
        WECHAT_DEFAULT_TEMPLATE_ID: env.WECHAT_DEFAULT_TEMPLATE_ID,
        WECHAT_CODE_LOGIN_ENABLED: env.WECHAT_CODE_LOGIN_ENABLED,
        BIND_CODE_TTL_SEC: env.BIND_CODE_TTL_SEC,
        EGRESS_BASE_URL: env.EGRESS_BASE_URL,
        EGRESS_SHARED_SECRET: env.EGRESS_SHARED_SECRET,
        ADMIN_BOOTSTRAP_KEY: env.ADMIN_BOOTSTRAP_KEY,
        ALLOW_TEST_TOKEN: env.ALLOW_TEST_TOKEN
      };
      return createAppHandler(runtime)(request);
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("cf-notify is running", {
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }
};
