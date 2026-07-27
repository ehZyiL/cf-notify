import { createAppHandler } from "./app.mjs";
import { processQueueBatch, reconcileQueues } from "./reliable-delivery.mjs";

const ASSET_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "upgrade-insecure-requests"
].join("; ");

async function serveAsset(env, request) {
  const response = await env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", ASSET_SECURITY_POLICY);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  const pathname = new URL(request.url).pathname;
  headers.set(
    "Cross-Origin-Resource-Policy",
    pathname.startsWith("/channel-assets/") ? "cross-origin" : "same-origin"
  );
  headers.set(
    "Cache-Control",
    pathname.endsWith(".html") || !pathname.includes(".") ? "no-store" : "no-cache"
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function createRuntime(env) {
  return {
    db: env.DB,
    kv: env.KV,
    authService: env.CF_AUTH,
    dispatchQueue: env.NOTIFY_DISPATCH_QUEUE,
    deliveryQueue: env.NOTIFY_DELIVERY_QUEUE,
    CF_AUTH_ISSUER: env.CF_AUTH_ISSUER,
    WECHAT_TOKEN: env.WECHAT_TOKEN,
    WECHAT_CALLBACK_MAX_SKEW_SEC: env.WECHAT_CALLBACK_MAX_SKEW_SEC,
    WECHAT_AES_KEY: env.WECHAT_AES_KEY,
    WECHAT_APP_ID: env.WECHAT_APP_ID,
    WECHAT_QRCODE_URL: env.WECHAT_QRCODE_URL,
    WECHAT_ACCOUNT_NAME: env.WECHAT_ACCOUNT_NAME,
    WECHAT_ACCOUNT_URL: env.WECHAT_ACCOUNT_URL,
    WECHAT_DEFAULT_TEMPLATE_ID: env.WECHAT_DEFAULT_TEMPLATE_ID,
    WECHAT_SEND_MODE: env.WECHAT_SEND_MODE,
    WECOM_CALLBACK_TOKEN: env.WECOM_CALLBACK_TOKEN,
    WECOM_CALLBACK_MAX_SKEW_SEC: env.WECOM_CALLBACK_MAX_SKEW_SEC,
    WECOM_ENCODING_AES_KEY: env.WECOM_ENCODING_AES_KEY,
    WECOM_CORP_ID: env.WECOM_CORP_ID,
    WECOM_PROVIDER_ACCOUNT_ID: env.WECOM_PROVIDER_ACCOUNT_ID,
    WECOM_ACCOUNT_NAME: env.WECOM_ACCOUNT_NAME,
    WECOM_QRCODE_URL: env.WECOM_QRCODE_URL,
    WECOM_APP_URL: env.WECOM_APP_URL,
    TELEGRAM_BOT_NAME: env.TELEGRAM_BOT_NAME,
    TELEGRAM_BOT_URL: env.TELEGRAM_BOT_URL,
    TELEGRAM_QRCODE_URL: env.TELEGRAM_QRCODE_URL,
    EGRESS_BASE_URL: env.EGRESS_BASE_URL,
    EGRESS_SHARED_SECRET: env.EGRESS_SHARED_SECRET,
    EGRESS_TIMEOUT_MS: env.EGRESS_TIMEOUT_MS,
    ADMIN_OAUTH_CLIENT_ID: env.ADMIN_OAUTH_CLIENT_ID,
    CF_AUTH_ACCOUNT_URL: env.CF_AUTH_ACCOUNT_URL,
    oauthFetch: env.oauthFetch,
    RECONCILE_AFTER_SEC: env.RECONCILE_AFTER_SEC,
    RECONCILE_BATCH_SIZE: env.RECONCILE_BATCH_SIZE,
    SUBSCRIPTIONS_DEFAULT_OPEN: env.SUBSCRIPTIONS_DEFAULT_OPEN,
    NOTIFICATION_DIRECTORY_MODE: env.NOTIFICATION_DIRECTORY_MODE,
    WECHAT_PROVIDER_ACCOUNT_ID: env.WECHAT_PROVIDER_ACCOUNT_ID
  };
}

/**
 * Cloudflare Worker entry for cf-notify.
 *
 * Bindings: DB (D1), KV, ASSETS
 * Secrets: WECHAT_TOKEN, EGRESS_BASE_URL, EGRESS_SHARED_SECRET
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const isApi =
      path.startsWith("/api/") ||
      path.startsWith("/v1/") ||
      path.startsWith("/wechat/") ||
      path.startsWith("/wecom/") ||
      path === "/health" ||
      path === "/healthz" ||
      path === "/api/health";

    if (isApi) {
      return createAppHandler(createRuntime(env))(request);
    }

    if (path === "/" || path === "/index.html") {
      const destination = env.CF_AUTH_ACCOUNT_URL
        || `${String(env.CF_AUTH_ISSUER || "").replace(/\/$/, "")}/#notifications`;
      return new Response(null, {
        status: 302,
        headers: {
          Location: destination,
          "Cache-Control": "no-store",
          Pragma: "no-cache"
        }
      });
    }

    if (env.ASSETS) {
      // Pretty routes for admin console
      const clean = path.replace(/\/$/, "") || "/";
      if (clean === "/admin") {
        return serveAsset(env, new Request(new URL("/admin.html", url), request));
      }
      return serveAsset(env, request);
    }
    return new Response("cf-notify is running", {
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  },

  async queue(batch, env) {
    await processQueueBatch(batch, createRuntime(env));
  },

  async scheduled(_controller, env) {
    await reconcileQueues(createRuntime(env));
  }
};
