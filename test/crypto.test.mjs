import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashSecret, verifySecret, signJwtHs256, verifyJwtHs256, sha1Hex } from "../src/crypto.mjs";

describe("S0 crypto", () => {
  it("hashes and verifies secrets", async () => {
    const h = await hashSecret("super-secret-key");
    assert.equal(await verifySecret("super-secret-key", h), true);
    assert.equal(await verifySecret("wrong", h), false);
  });

  it("signs and verifies JWT", async () => {
    const secret = "jwt-secret-at-least-32-bytes-long!!";
    const token = await signJwtHs256({ sub: "u1", email: "a@x.com" }, secret, { ttlSeconds: 600 });
    const payload = await verifyJwtHs256(token, secret);
    assert.equal(payload.sub, "u1");
  });

  it("computes sha1 for wechat signature", async () => {
    const hex = await sha1Hex("nonce" + "token" + "timestamp");
    assert.match(hex, /^[0-9a-f]{40}$/);
  });
});
