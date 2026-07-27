import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryDb } from "../src/sqlite-d1.mjs";
import { createMemoryKv } from "../src/memory-kv.mjs";
import { createAppHandler } from "../src/app.mjs";
import { createNotifyClient } from "../src/auth-service.mjs";
import { signJwtHs256, sha1Hex } from "../src/crypto.mjs";
import { listBindingsForUser } from "../src/bindings.mjs";

const JWT_SECRET = "test-jwt-secret-at-least-32-bytes-long!!";

function makeEnv(overrides = {}) {
  return {
    db: createMemoryDb(),
    kv: createMemoryKv(),
    CF_AUTH_JWT_SECRET: JWT_SECRET,
    WECHAT_TOKEN: "wx-token",
    BIND_CODE_TTL_SEC: "300",
    ADMIN_BOOTSTRAP_KEY: "boot-admin",
    ALLOW_TEST_TOKEN: "true",
    ...overrides
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

  it("user bind code + wechat callback + service send (mock egress)", async () => {
    const env = makeEnv();
    const handler = createAppHandler(env);
    const userId = "user-http-1";
    const userJwt = await signJwtHs256(
      { sub: userId, email: "u@example.com" },
      JWT_SECRET,
      { ttlSeconds: 3600 }
    );

    const codeRes = await jsonFetch(handler, "/api/bindings/code", {
      method: "POST",
      headers: { Authorization: `Bearer ${userJwt}` },
      body: { channel: "wechat_oa" }
    });
    assert.equal(codeRes.status, 200, JSON.stringify(codeRes.data));
    const code = codeRes.data.code;

    // WeChat GET verify
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = "n1";
    const token = env.WECHAT_TOKEN;
    const signature = await sha1Hex([token, timestamp, nonce].sort().join(""));
    const verifyRes = await handler(
      new Request(
        `https://notify.example.com/wechat/callback?signature=${signature}&timestamp=${timestamp}&nonce=${nonce}&echostr=helloEcho`
      )
    );
    assert.equal(await verifyRes.text(), "helloEcho");

    // WeChat POST bind message
    const postSig = await sha1Hex([token, timestamp, nonce].sort().join(""));
    const xml = `<xml>
      <ToUserName><![CDATA[gh]]></ToUserName>
      <FromUserName><![CDATA[openid-http]]></FromUserName>
      <MsgType><![CDATA[text]]></MsgType>
      <Content><![CDATA[${code}]]></Content>
    </xml>`;
    const cbRes = await handler(
      new Request(
        `https://notify.example.com/wechat/callback?signature=${postSig}&timestamp=${timestamp}&nonce=${nonce}`,
        { method: "POST", body: xml }
      )
    );
    const cbText = await cbRes.text();
    assert.match(cbText, /绑定成功/);

    const bindings = await listBindingsForUser(env.db, userId);
    assert.equal(bindings[0].externalId, "openid-http");

    // Service client + send with mock by setting EGRESS and intercepting via env inject
    // Use send path: create client and call /api/v1/send with mock by temporarily
    // not configuring egress → failed; better inject through creating client and
    // testing not_bound vs bound with real sendNotification already covered.
    // Here assert list bindings API:
    const list = await jsonFetch(handler, "/api/bindings", {
      headers: { Authorization: `Bearer ${userJwt}` }
    });
    assert.equal(list.status, 200);
    assert.equal(list.data.bindings.length, 1);

    const client = await createNotifyClient(env.db, {
      serviceId: "xy-erp",
      name: "test",
      clientSecret: "svc-secret-12345678"
    });

    // Without egress configured → failed status for bound user
    const sendRes = await jsonFetch(handler, "/api/v1/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${client.clientId}:svc-secret-12345678`
      },
      body: {
        user_id: userId,
        event: "test",
        title: "hi",
        body: "there"
      }
    });
    assert.equal(sendRes.status, 200);
    assert.equal(sendRes.data.results[0].channel, "wechat_oa");
    // bound but egress missing → failed
    assert.equal(sendRes.data.results[0].status, "failed");
    assert.match(sendRes.data.results[0].error, /EGRESS/);
  });

  it("creates service client via admin bootstrap key", async () => {
    const env = makeEnv();
    const handler = createAppHandler(env);
    const res = await jsonFetch(handler, "/api/admin/clients", {
      method: "POST",
      headers: { "X-Admin-Bootstrap-Key": "boot-admin" },
      body: { serviceId: "demo", name: "Demo" }
    });
    assert.equal(res.status, 200);
    assert.ok(res.data.client.clientSecret);
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
    const apiResponse = await handler(
      new Request("https://notify.example.com/api/test/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: oversized })
      })
    );
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

  it("only lets a user manage subscriptions for assigned services", async () => {
    const env = makeEnv({ ENFORCE_USER_SERVICE_MEMBERSHIP: "true" });
    const handler = createAppHandler(env);
    const deniedToken = await signJwtHs256(
      { sub: "user-sub", services: [] },
      JWT_SECRET,
      { ttlSeconds: 3600 }
    );
    const denied = await jsonFetch(handler, "/api/subscriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${deniedToken}` },
      body: { serviceId: "xy-erp", eventType: "order.approved" }
    });
    assert.equal(denied.status, 403);

    const allowedToken = await signJwtHs256(
      { sub: "user-sub", services: [{ id: "xy-erp", role: "user" }] },
      JWT_SECRET,
      { ttlSeconds: 3600 }
    );
    const allowed = await jsonFetch(handler, "/api/subscriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${allowedToken}` },
      body: { serviceId: "xy-erp", eventType: "order.approved" }
    });
    assert.equal(allowed.status, 200);
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

  it("proxies legacy binding UI operations to cf-auth in RPC mode", async () => {
    const calls = [];
    const env = makeEnv({
      NOTIFICATION_DIRECTORY_MODE: "rpc",
      WECHAT_PROVIDER_ACCOUNT_ID: "wechat-main",
      authService: {
        async createBindingChallenge(input) {
          calls.push(["create", input]);
          return { token: "ABCD2345", expiresAt: Date.now() + 300000, expireIn: 300 };
        },
        async getBindingChallengeStatus(input) {
          calls.push(["status", input]);
          return { status: "verified", bindingId: "nb_1" };
        },
        async listNotificationBindings(input) {
          calls.push(["list", input]);
          return [{
            id: "nb_1",
            userId: input.userId,
            channel: "wechat_oa",
            providerAccountId: "wechat-main",
            maskedLabel: "op***1234",
            status: "verified"
          }];
        },
        async revokeNotificationBinding(input) {
          calls.push(["revoke", input]);
          return { ok: true };
        }
      }
    });
    const handler = createAppHandler(env);
    const token = await signJwtHs256(
      { sub: "rpc-user", services: [{ id: "orders" }] },
      JWT_SECRET,
      { ttlSeconds: 3600 }
    );
    const headers = { Authorization: `Bearer ${token}` };

    const created = await jsonFetch(handler, "/api/bindings/code", {
      method: "POST",
      headers,
      body: { channel: "wechat_oa" }
    });
    assert.equal(created.status, 200);
    assert.equal(created.data.code, "ABCD2345");
    assert.equal((await jsonFetch(handler, "/api/bindings", { headers })).data.bindings[0].maskedLabel, "op***1234");
    assert.equal((await jsonFetch(handler, "/api/bindings/status?code=ABCD2345", { headers })).data.status, "verified");
    assert.equal((await jsonFetch(handler, "/api/bindings/nb_1", { method: "DELETE", headers })).status, 200);
    assert.equal((await jsonFetch(handler, "/api/subscriptions", { headers })).status, 409);
    assert.deepEqual(calls.map(([name]) => name), ["create", "list", "status", "revoke"]);
    assert.equal(calls[0][1].providerAccountId, "wechat-main");
  });
});
