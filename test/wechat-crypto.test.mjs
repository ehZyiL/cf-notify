import assert from "node:assert/strict";
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
});
