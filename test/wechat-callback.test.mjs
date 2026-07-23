import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryKv } from "../src/memory-kv.mjs";
import { createMemoryDb } from "../src/sqlite-d1.mjs";
import { createBindCode, listBindingsForUser } from "../src/bindings.mjs";
import {
  verifyWechatSignature,
  parseWechatXml,
  handleWechatMessage
} from "../src/channels/wechat-callback.mjs";
import { sha1Hex } from "../src/crypto.mjs";

describe("S4 wechat callback", () => {
  it("verifies wechat URL signature", async () => {
    const token = "myToken";
    const timestamp = "1710000000";
    const nonce = "nonce1";
    const arr = [token, timestamp, nonce].sort();
    const signature = await sha1Hex(arr.join(""));
    assert.equal(
      await verifyWechatSignature(token, { signature, timestamp, nonce }),
      true
    );
    assert.equal(
      await verifyWechatSignature(token, { signature: "deadbeef", timestamp, nonce }),
      false
    );
  });

  it("parses wechat xml message", () => {
    const xml = `<xml>
      <ToUserName><![CDATA[gh_x]]></ToUserName>
      <FromUserName><![CDATA[openid99]]></FromUserName>
      <MsgType><![CDATA[text]]></MsgType>
      <Content><![CDATA[AB12CD]]></Content>
    </xml>`;
    const msg = parseWechatXml(xml);
    assert.equal(msg.FromUserName, "openid99");
    assert.equal(msg.Content, "AB12CD");
  });

  it("binds user when message content is a valid code", async () => {
    const kv = createMemoryKv();
    const db = createMemoryDb();
    const { code } = await createBindCode(kv, {
      userId: "user-42",
      channel: "wechat_oa"
    });

    const env = { kv, db, WECHAT_TOKEN: "t" };
    const xml = `<xml>
      <ToUserName><![CDATA[gh]]></ToUserName>
      <FromUserName><![CDATA[oX-openid]]></FromUserName>
      <MsgType><![CDATA[text]]></MsgType>
      <Content><![CDATA[${code}]]></Content>
    </xml>`;
    const res = await handleWechatMessage(env, xml);
    const text = await res.text();
    assert.match(text, /绑定成功/);

    const bindings = await listBindingsForUser(db, "user-42");
    assert.equal(bindings[0].externalId, "oX-openid");
  });
});
