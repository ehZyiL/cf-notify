import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv } from "node:crypto";
import { describe, it } from "node:test";
import { wechatEncrypt, wechatDecrypt } from "../src/channels/wechat-crypto.mjs";

// 43-char EncodingAESKey (base64 without padding) — standard test pattern length
function makeAesKey() {
  // 32 random bytes → base64 → strip padding → should be 43 chars
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = i + 1;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, "");
}

function decodeKey(encodingAesKey) {
  return Buffer.from(`${encodingAesKey}=`, "base64");
}

function protocolPad(data) {
  const pad = 32 - (data.length % 32);
  return Buffer.concat([data, Buffer.alloc(pad, pad)]);
}

function protocolEncrypt(plain, encodingAesKey, appId) {
  const key = decodeKey(encodingAesKey);
  const message = Buffer.from(plain);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(message.length);
  const raw = Buffer.concat([Buffer.alloc(16, 7), length, message, Buffer.from(appId)]);
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(protocolPad(raw)), cipher.final()]).toString("base64");
}

function protocolDecrypt(encrypted, encodingAesKey) {
  const key = decodeKey(encodingAesKey);
  const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  const padded = Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64")),
    decipher.final()
  ]);
  const pad = padded[padded.length - 1];
  const raw = padded.subarray(0, padded.length - pad);
  const messageLength = raw.readUInt32BE(16);
  return raw.subarray(20, 20 + messageLength).toString();
}

describe("S10 wechat aes crypto", () => {
  it("round-trips encrypt/decrypt", async () => {
    const key = makeAesKey();
    assert.equal(key.length, 43);
    const appId = "wxAPPIDTEST0001";
    const plain = "<xml><Content><![CDATA[hello]]></Content></xml>";
    const enc = await wechatEncrypt(plain, key, appId);
    assert.ok(enc.length > 20);
    const dec = await wechatDecrypt(enc, key, appId);
    assert.equal(dec, plain);
  });

  it("interoperates with protocol AES-CBC when 32-byte padding exceeds 16 bytes", async () => {
    const key = makeAesKey();
    const appId = "ww37c322e2b04fab42";
    const plain = `<xml><Content><![CDATA[FW99K77J]]></Content>${"x".repeat(237)}</xml>`;
    const officialCiphertext = protocolEncrypt(plain, key, appId);

    assert.equal(await wechatDecrypt(officialCiphertext, key, appId), plain);

    const workerCiphertext = await wechatEncrypt(plain, key, appId);
    assert.equal(protocolDecrypt(workerCiphertext, key), plain);
  });
});
