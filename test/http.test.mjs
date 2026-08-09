import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryDb } from "../src/sqlite-d1.mjs";
import { createMemoryKv } from "../src/memory-kv.mjs";
import { createAppHandler } from "../src/app.mjs";
import { createNotifyClient, getNotifyClient } from "../src/auth-service.mjs";
import { verifyServiceSecret } from "../src/crypto.mjs";
import { sha1Hex } from "../src/crypto.mjs";

const ADMIN_SESSION_ID = "http-test-admin-session";

function makeEnv(overrides = {}) {
  const db = createMemoryDb();
  return {
    db,
    kv: createMemoryKv(),
    WECHAT_TOKEN: "wx-token",
    WECOM_CALLBACK_TOKEN: "wecom-token",
    WECOM_ENCODING_AES_KEY: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
    WECOM_CORP_ID: "ww-test-corp",
    EGRESS_BASE_URL: "https://egress.example.com",
    EGRESS_SHARED_SECRET: "test-egress-secret",
    egressFetch: async () => new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" }
    }),
    CF_AUTH_ISSUER: "https://auth.example.com",
    ADMIN_OAUTH_CLIENT_ID: "cf-notify-admin",
    authService: {
      async verifyAdminAccessToken({ clientId, accessToken }) {
        assert.equal(clientId, "cf-notify-admin");
        assert.equal(accessToken, "http-test-admin-token");
        return {
          valid: true,
          userId: "admin-http-1",
          platformRole: "admin",
          serviceId: "cf-notify",
          serviceRole: "admin"
        };
      },
      async verifyServiceApiKey(rawKey) {
        const [clientId, secret] = rawKey.includes(":") ? rawKey.split(":") : [rawKey, ""];
        const client = await getNotifyClient(db, clientId);
        if (!client || Number(client.enabled) !== 1) {
          return { valid: false, active: false };
        }
        const ok = await verifyServiceSecret(secret, client.secretHash);
        if (!ok) return { valid: false, active: false };
        return {
          valid: true,
          keyId: client.clientId,
          serviceId: client.serviceId,
          name: client.name,
          scopes: client.scopes,
          active: true
        };
      },
      async authorizeNotificationEvent(input) {
        return { ...input, enabled: true, channels: [] };
      }
    },
    ...overrides
  };
}

async function adminHeaders(env, { write = false } = {}) {
  await env.kv.put(
    `admin:session:${ADMIN_SESSION_ID}`,
    JSON.stringify({
      accessToken: "http-test-admin-token",
      expiresAt: Date.now() + 15 * 60 * 1000,
      user: { id: "admin-http-1", email: "admin@example.com" },
      createdAt: Date.now()
    }),
    { expirationTtl: 900 }
  );
  return {
    Cookie: `__Host-cf_notify_admin_session=${ADMIN_SESSION_ID}`,
    ...(write ? { "X-CSRF-Protection": "same-origin" } : {})
  };
}

async function jsonFetch(handler, path, { method = "GET", body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await handler(new Request(`https://notify.example.com${path}`, init));
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers, raw: text };
}

describe("S6 HTTP entry", () => {
  it("health check", async () => {
    const handler = createAppHandler(makeEnv());
    const res = await jsonFetch(handler, "/api/health");
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
  });

  it("creates service client through an authenticated admin session", async () => {
    const env = makeEnv();
    const handler = createAppHandler(env);
    const res = await jsonFetch(handler, "/api/admin/clients", {
      method: "POST",
      headers: await adminHeaders(env, { write: true }),
      body: { serviceId: "demo", name: "Demo" }
    });
    assert.equal(res.status, 200);
    assert.ok(res.data.client.clientSecret);
  });

  it("does not expose retired user APIs or bootstrap authentication", async () => {
    const env = makeEnv();
    const handler = createAppHandler(env);
    for (const path of [
      "/api/bindings",
      "/api/bindings/code",
      "/api/subscriptions",
      "/api/logs",
      "/api/test/token",
      "/api/session/wechat/challenge"
    ]) {
      assert.equal((await jsonFetch(handler, path)).status, 404, path);
    }

    const admin = await jsonFetch(handler, "/api/admin/clients", {
      headers: { "X-Admin-Bootstrap-Key": "obsolete" }
    });
    assert.equal(admin.status, 401);
  });

  it("publishes and dynamically updates channel guide links", async () => {
    const env = makeEnv({
      WECOM_ACCOUNT_NAME: "Example Corp",
      WECOM_QRCODE_URL: "https://notify.example.com/channel-assets/wecom-join.jpg"
    });
    const handler = createAppHandler(env);
    const writeHeaders = await adminHeaders(env, { write: true });

    const initial = await jsonFetch(handler, "/api/channel-guides");
    assert.equal(initial.status, 200);
    assert.equal(initial.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(initial.data.guides.length, 1);
    assert.equal(initial.data.guides[0].channel, "wecom");
    assert.equal(initial.data.guides[0].accountName, "Example Corp");
    assert.equal(initial.data.channels.find((item) => item.channel === "wecom").available, true);
    assert.equal(initial.data.channels.find((item) => item.channel === "telegram").reason, "not_implemented");

    const updated = await jsonFetch(handler, "/api/admin/channel-guides/wecom", {
      method: "PUT",
      headers: writeHeaders,
      body: {
        enabled: true,
        accountName: "Updated Corp",
        imageUrl: "https://cdn.example.com/wecom.jpg",
        actionUrl: "https://work.weixin.qq.com/example"
      }
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.guide.source, "kv");

    const dynamic = await jsonFetch(handler, "/api/channel-guides");
    assert.equal(dynamic.data.guides[0].accountName, "Updated Corp");
    assert.equal(dynamic.data.guides[0].imageUrl, "https://cdn.example.com/wecom.jpg");

    const reset = await jsonFetch(handler, "/api/admin/channel-guides/wecom", {
      method: "DELETE",
      headers: writeHeaders
    });
    assert.equal(reset.status, 200);
    assert.equal(reset.data.guide.source, "env");
    assert.equal(reset.data.guide.accountName, "Example Corp");
  });

  it("rejects insecure channel guide links", async () => {
    const env = makeEnv();
    const handler = createAppHandler(env);
    const response = await jsonFetch(handler, "/api/admin/channel-guides/wecom", {
      method: "PUT",
      headers: await adminHeaders(env, { write: true }),
      body: { enabled: true, imageUrl: "http://example.com/wecom.jpg" }
    });
    assert.equal(response.status, 400);
    assert.match(response.data.error, /HTTPS URL/);
  });

  it("does not let an unfinished channel become a public guide", async () => {
    const env = makeEnv();
    const handler = createAppHandler(env);
    const response = await jsonFetch(handler, "/api/admin/channel-guides/telegram", {
      method: "PUT",
      headers: await adminHeaders(env, { write: true }),
      body: {
        enabled: true,
        displayName: "Telegram",
        actionUrl: "https://t.me/example_bot"
      }
    });
    assert.equal(response.status, 409);
    assert.equal(response.data.details.reason, "not_implemented");

    const publicGuides = await jsonFetch(handler, "/api/channel-guides");
    assert.equal(publicGuides.data.guides.some((item) => item.channel === "telegram"), false);
  });

  it("reports runtime ownership and dependency readiness to administrators", async () => {
    const env = makeEnv({
      NOTIFICATION_DIRECTORY_MODE: "rpc",
      WECHAT_SEND_MODE: "custom_text",
      dispatchQueue: { send: async () => {} },
      deliveryQueue: { send: async () => {} }
    });
    const handler = createAppHandler(env);
    const headers = await adminHeaders(env);

    const runtime = await jsonFetch(handler, "/api/admin/runtime", { headers });
    assert.equal(runtime.status, 200);
    assert.equal(runtime.data.directoryMode, "rpc");
    assert.equal(runtime.data.serviceCredentials.source, "cf-auth");
    assert.equal(runtime.data.messaging.templateMappingEnabled, false);

    const readiness = await jsonFetch(handler, "/api/admin/readiness", { headers });
    assert.equal(readiness.status, 200);
    assert.equal(readiness.data.ok, true);
    assert.equal(readiness.data.checks.database.status, "ok");
    assert.equal(readiness.data.checks.egress.status, "ok");
  });

  it("prevents local service credential writes in rpc mode", async () => {
    const env = makeEnv({ NOTIFICATION_DIRECTORY_MODE: "rpc" });
    const handler = createAppHandler(env);
    const response = await jsonFetch(handler, "/api/admin/clients", {
      method: "POST",
      headers: await adminHeaders(env, { write: true }),
      body: { serviceId: "xy-erp" }
    });
    assert.equal(response.status, 409);
    assert.equal(response.data.details.managedBy, "cf-auth");
  });

  it("previews retries and permits only reviewed retry candidates", async () => {
    const queued = [];
    const env = makeEnv({ deliveryQueue: { send: async (body) => queued.push(body) } });
    const now = new Date().toISOString();
    await env.db.prepare(
      `INSERT INTO notification_events
       (id, service_id, client_id, user_id, event_type, idempotency_key, request_hash,
        payload_json, locale, occurred_at, status, created_at, updated_at)
       VALUES ('evt_retry', 'xy-erp', 'key-1', 'usr-1', 'notification.test', 'retry-key',
               'hash', '{}', NULL, ?, 'failed', ?, ?)`
    ).bind(now, now, now).run();
    await env.db.prepare(
      `INSERT INTO notification_deliveries
       (id, event_id, channel, binding_id, target_key, status, attempts, error_code,
        created_at, updated_at)
       VALUES ('dlv_permanent', 'evt_retry', 'wecom', 'binding-1', 'binding-1',
               'failed', 1, 'invalid_user', ?, ?),
              ('dlv_dlq', 'evt_retry', 'wecom', 'binding-2', 'binding-2',
               'failed', 8, 'delivery_dlq', ?, ?),
              ('dlv_unknown', 'evt_retry', 'wecom', 'binding-3', 'binding-3',
               'unknown', 8, 'delivery_dlq', ?, ?)`
    ).bind(now, now, now, now, now, now).run();
    const handler = createAppHandler(env);
    const writeHeaders = await adminHeaders(env, { write: true });

    const preview = await jsonFetch(handler, "/api/admin/retry", {
      method: "POST",
      headers: writeHeaders,
      body: {}
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.data.dryRun, true);
    assert.equal(preview.data.candidates.length, 3);
    assert.equal(preview.data.candidates.find((item) => item.deliveryId === "dlv_permanent").canRetry, false);

    const permanent = await jsonFetch(handler, "/api/admin/deliveries/dlv_permanent/retry", {
      method: "POST",
      headers: writeHeaders,
      body: {}
    });
    assert.equal(permanent.status, 409);

    const dlq = await jsonFetch(handler, "/api/admin/deliveries/dlv_dlq/retry", {
      method: "POST",
      headers: writeHeaders,
      body: {}
    });
    assert.equal(dlq.status, 200);

    const unknownWithoutAck = await jsonFetch(handler, "/api/admin/deliveries/dlv_unknown/retry", {
      method: "POST",
      headers: writeHeaders,
      body: {}
    });
    assert.equal(unknownWithoutAck.status, 409);

    const unknown = await jsonFetch(handler, "/api/admin/deliveries/dlv_unknown/retry", {
      method: "POST",
      headers: writeHeaders,
      body: { acknowledgeUnknownDuplicateRisk: true }
    });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.data.duplicateRisk, true);
    assert.deepEqual(queued, [{ deliveryId: "dlv_dlq" }, { deliveryId: "dlv_unknown" }]);
  });

  it("rejects send without service auth", async () => {
    const handler = createAppHandler(makeEnv());
    const res = await jsonFetch(handler, "/api/v1/send", {
      method: "POST",
      body: { user_id: "u" }
    });
    assert.equal(res.status, 401);
  });

  it("rejects oversized JSON and WeChat callback bodies", async () => {
    const env = makeEnv();
    const handler = createAppHandler(env);
    const oversized = "x".repeat(129 * 1024);
    const serviceClient = await createNotifyClient(env.db, {
      serviceId: "oversized-test",
      clientSecret: "oversized-secret"
    });
    const apiResponse = await handler(new Request("https://notify.example.com/api/v1/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceClient.clientId}:oversized-secret`
      },
      body: JSON.stringify({ value: oversized })
    }));
    assert.equal(apiResponse.status, 413);

    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = "oversized";
    const signature = await sha1Hex([env.WECHAT_TOKEN, timestamp, nonce].sort().join(""));
    const callbackResponse = await handler(
      new Request(`https://notify.example.com/wechat/callback?signature=${signature}&timestamp=${timestamp}&nonce=${nonce}`, {
        method: "POST",
        body: oversized
      })
    );
    assert.equal(callbackResponse.status, 413);
  });

  it("accepts and queries a reliable notification event", async () => {
    const dispatchMessages = [];
    const env = makeEnv({
      dispatchQueue: { send: async (body) => dispatchMessages.push(body) },
      deliveryQueue: { send: async () => {} }
    });
    const handler = createAppHandler(env);
    const serviceClient = await createNotifyClient(env.db, {
      serviceId: "xy-erp",
      clientSecret: "reliable-secret"
    });
    const auth = { Authorization: `Bearer ${serviceClient.clientId}:reliable-secret` };

    const missingKey = await jsonFetch(handler, "/api/v1/notifications", {
      method: "POST",
      headers: auth,
      body: { userId: "user-event", type: "order.approved", data: { orderNo: "1" } }
    });
    assert.equal(missingKey.status, 400);

    const accepted = await jsonFetch(handler, "/api/v1/notifications", {
      method: "POST",
      headers: { ...auth, "Idempotency-Key": "order:1:approved" },
      body: { userId: "user-event", type: "order.approved", data: { orderNo: "1" } }
    });
    assert.equal(accepted.status, 202);
    assert.equal(accepted.data.status, "accepted");
    assert.equal(dispatchMessages.length, 1);

    const status = await jsonFetch(handler, `/api/v1/notifications/${accepted.data.eventId}`, {
      headers: auth
    });
    assert.equal(status.status, 200);
    assert.equal(status.data.eventId, accepted.data.eventId);
    assert.deepEqual(status.data.deliveries, []);
  });

  it("returns effective notification settings from cf-auth without exposing targets", async () => {
    const calls = [];
    const env = makeEnv({
      NOTIFICATION_DIRECTORY_MODE: "rpc",
      authService: {
        async verifyServiceApiKey(rawKey) {
          calls.push(["verify", rawKey]);
          return {
            valid: true,
            keyId: "key-settings",
            serviceId: "xy-erp",
            scopes: ["notifications.settings.read"]
          };
        },
        async getEffectiveNotificationSettings(input) {
          calls.push(["settings", input]);
          return {
            ...input,
            enabled: true,
            channels: [{
              channel: "wechat_oa",
              available: true,
              enabled: true,
              maskedTarget: "wx***1234",
              address: "private-openid"
            }],
            version: "v1"
          };
        }
      }
    });
    const handler = createAppHandler(env);

    const result = await jsonFetch(
      handler,
      "/api/v1/users/usr_1/notification-settings?eventType=order.approved",
      { headers: { Authorization: "Bearer cfk_settings_secret" } }
    );

    assert.equal(result.status, 200);
    assert.equal(result.data.serviceId, "xy-erp");
    assert.equal(result.data.channels[0].maskedTarget, "wx***1234");
    assert.equal("address" in result.data.channels[0], false);
    assert.deepEqual(calls, [
      ["verify", "cfk_settings_secret"],
      ["settings", {
        serviceId: "xy-erp",
        userId: "usr_1",
        eventType: "order.approved"
      }]
    ]);
  });

});
