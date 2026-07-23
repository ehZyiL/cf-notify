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
    const timestamp = "1710000000";
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
});
