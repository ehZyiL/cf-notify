import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAppHandler } from "../src/app.mjs";
import {
  claimWecomCallback,
  handleWecomMessage,
  isFreshWecomTimestamp,
  verifyWecomSignature
} from "../src/channels/wecom-callback.mjs";
import { parseWechatXml } from "../src/channels/wechat-callback.mjs";
import { wechatDecrypt, wechatEncrypt } from "../src/channels/wechat-crypto.mjs";
import { sha1Hex } from "../src/crypto.mjs";
import { createMemoryKv } from "../src/memory-kv.mjs";
import { createMemoryDb } from "../src/sqlite-d1.mjs";

const TOKEN = "wecom-callback-token";
const CORP_ID = "ww-test-corp-id";

function makeAesKey() {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index + 1;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/, "");
}

async function signature(timestamp, nonce, encrypt) {
  return sha1Hex([TOKEN, timestamp, nonce, encrypt].sort().join(""));
}

function makeEnv(overrides = {}) {
  return {
    db: createMemoryDb(),
    kv: createMemoryKv(),
    WECOM_CALLBACK_TOKEN: TOKEN,
    WECOM_ENCODING_AES_KEY: makeAesKey(),
    WECOM_CORP_ID: CORP_ID,
    WECOM_PROVIDER_ACCOUNT_ID: "wecom-main",
    WECOM_CALLBACK_MAX_SKEW_SEC: "300",
    NOTIFICATION_DIRECTORY_MODE: "rpc",
    ...overrides
  };
}

async function decryptReply(response, env) {
  const outer = parseWechatXml(await response.text());
  assert.ok(outer.Encrypt);
  const xml = await wechatDecrypt(outer.Encrypt, env.WECOM_ENCODING_AES_KEY, CORP_ID);
  return parseWechatXml(xml);
}

describe("WeCom encrypted callback", () => {
  it("verifies signatures, freshness, and replay claims", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = "nonce-1";
    const encrypt = "encrypted-payload";
    const msgSignature = await signature(timestamp, nonce, encrypt);

    assert.equal(await verifyWecomSignature(TOKEN, {
      msgSignature,
      timestamp,
      nonce,
      encrypt
    }), true);
    assert.equal(await verifyWecomSignature(TOKEN, {
      msgSignature: "deadbeef",
      timestamp,
      nonce,
      encrypt
    }), false);
    assert.equal(isFreshWecomTimestamp(timestamp), true);
    assert.equal(isFreshWecomTimestamp("1710000000"), false);

    const db = createMemoryDb();
    const receipt = { signature: msgSignature, timestamp, nonce, body: "<xml/>" };
    assert.equal(await claimWecomCallback(db, receipt), true);
    assert.equal(await claimWecomCallback(db, receipt), false);
  });

  it("decrypts URL verification echo and rejects invalid or stale signatures", async () => {
    const env = makeEnv();
    const handler = createAppHandler(env);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = "nonce-echo";
    const encryptedEcho = await wechatEncrypt("verified-echo", env.WECOM_ENCODING_AES_KEY, CORP_ID);
    const msgSignature = await signature(timestamp, nonce, encryptedEcho);
    const base = "https://notify.example.com/wecom/callback";

    const response = await handler(new Request(
      `${base}?msg_signature=${encodeURIComponent(msgSignature)}`
        + `&timestamp=${timestamp}&nonce=${nonce}&echostr=${encodeURIComponent(encryptedEcho)}`
    ));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "verified-echo");

    const invalid = await handler(new Request(
      `${base}?msg_signature=invalid&timestamp=${timestamp}&nonce=${nonce}`
        + `&echostr=${encodeURIComponent(encryptedEcho)}`
    ));
    assert.equal(invalid.status, 403);

    const staleTimestamp = "1710000000";
    const staleSignature = await signature(staleTimestamp, nonce, encryptedEcho);
    const stale = await handler(new Request(
      `${base}?msg_signature=${staleSignature}&timestamp=${staleTimestamp}`
        + `&nonce=${nonce}&echostr=${encodeURIComponent(encryptedEcho)}`
    ));
    assert.equal(stale.status, 403);
  });

  it("binds the sender through cf-auth once without persisting the WeCom user ID", async () => {
    const calls = [];
    const rateLimitKeys = [];
    const kv = createMemoryKv();
    const env = makeEnv({
      kv: {
        get: (key) => kv.get(key),
        put(key, value, options) {
          rateLimitKeys.push(key);
          return kv.put(key, value, options);
        },
        delete: (key) => kv.delete(key)
      },
      authService: {
        async consumeBindingChallenge(input) {
          calls.push(input);
          return { ok: true, bindingId: "nb_wecom_1" };
        }
      }
    });
    const handler = createAppHandler(env);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = "nonce-bind";
    const plainXml = `<xml>
      <ToUserName><![CDATA[${CORP_ID}]]></ToUserName>
      <FromUserName><![CDATA[zhangsan]]></FromUserName>
      <CreateTime>${timestamp}</CreateTime>
      <MsgType><![CDATA[text]]></MsgType>
      <Content><![CDATA[AB12CD34]]></Content>
      <MsgId>1234567890</MsgId>
      <AgentID>1000002</AgentID>
    </xml>`;
    const encrypted = await wechatEncrypt(plainXml, env.WECOM_ENCODING_AES_KEY, CORP_ID);
    const outerXml = `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`;
    const msgSignature = await signature(timestamp, nonce, encrypted);
    const url = "https://notify.example.com/wecom/callback"
      + `?msg_signature=${msgSignature}&timestamp=${timestamp}&nonce=${nonce}`;

    const first = await handler(new Request(url, { method: "POST", body: outerXml }));
    assert.equal(first.status, 200);
    const reply = await decryptReply(first, env);
    assert.equal(reply.ToUserName, "zhangsan");
    assert.match(reply.Content, /绑定成功/);

    const replay = await handler(new Request(url, { method: "POST", body: outerXml }));
    assert.equal(replay.status, 200);
    assert.equal(await replay.text(), "success");
    assert.deepEqual(calls, [{
      token: "AB12CD34",
      channel: "wecom",
      providerAccountId: "wecom-main",
      externalIdentifier: "zhangsan",
      metadata: { agentId: "1000002" }
    }]);
    assert.equal(rateLimitKeys.length, 1);
    assert.match(rateLimitKeys[0], /^rl:bind-openid-fail:wecom:[0-9a-f]{64}:/);
    assert.doesNotMatch(rateLimitKeys[0], /zhangsan/);

    const persisted = await env.db
      .prepare("SELECT * FROM channel_bindings WHERE external_id = ?")
      .bind("zhangsan")
      .first();
    assert.equal(persisted, null);
  });

  it("rejects encrypted payloads for a different CorpID", async () => {
    const env = makeEnv({
      authService: { async consumeBindingChallenge() { return { ok: true }; } }
    });
    const handler = createAppHandler(env);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = "nonce-wrong-corp";
    const encrypted = await wechatEncrypt(
      "<xml><FromUserName>zhangsan</FromUserName><MsgType>text</MsgType><Content>AB12CD34</Content></xml>",
      env.WECOM_ENCODING_AES_KEY,
      "ww-another-corp"
    );
    const msgSignature = await signature(timestamp, nonce, encrypted);
    const body = `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`;
    const response = await handler(new Request(
      `https://notify.example.com/wecom/callback?msg_signature=${msgSignature}`
        + `&timestamp=${timestamp}&nonce=${nonce}`,
      { method: "POST", body }
    ));

    assert.equal(response.status, 403);
  });

  it("allows the provider to retry after a temporary cf-auth RPC failure", async () => {
    let calls = 0;
    const env = makeEnv({
      authService: {
        async consumeBindingChallenge() {
          calls += 1;
          if (calls === 1) throw new Error("temporary RPC failure");
          return { ok: true, bindingId: "nb_retry" };
        }
      }
    });
    const handler = createAppHandler(env);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = "nonce-retry";
    const plainXml = `<xml>
      <FromUserName><![CDATA[retry-user]]></FromUserName>
      <MsgType><![CDATA[text]]></MsgType>
      <Content><![CDATA[AB12CD34]]></Content>
      <AgentID>1000002</AgentID>
    </xml>`;
    const encrypted = await wechatEncrypt(plainXml, env.WECOM_ENCODING_AES_KEY, CORP_ID);
    const body = `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`;
    const msgSignature = await signature(timestamp, nonce, encrypted);
    const url = "https://notify.example.com/wecom/callback"
      + `?msg_signature=${msgSignature}&timestamp=${timestamp}&nonce=${nonce}`;

    const failed = await handler(new Request(url, { method: "POST", body }));
    assert.equal(failed.status, 503);

    const retried = await handler(new Request(url, { method: "POST", body }));
    assert.equal(retried.status, 200);
    const reply = await decryptReply(retried, env);
    assert.match(reply.Content, /绑定成功/);
    assert.equal(calls, 2);
  });

  it("silently acknowledges non-text callbacks", async () => {
    const env = makeEnv();
    const innerXml = `<xml>
      <ToUserName><![CDATA[${CORP_ID}]]></ToUserName>
      <FromUserName><![CDATA[prompt-user]]></FromUserName>
      <MsgType><![CDATA[event]]></MsgType>
      <Event><![CDATA[enter_agent]]></Event>
      <AgentID>1000002</AgentID>
    </xml>`;
    const encrypted = await wechatEncrypt(innerXml, env.WECOM_ENCODING_AES_KEY, CORP_ID);
    const response = await handleWecomMessage(
      env,
      `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "success");
  });
});
