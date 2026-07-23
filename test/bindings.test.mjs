import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryKv } from "../src/memory-kv.mjs";
import { createMemoryDb } from "../src/sqlite-d1.mjs";
import {
  createBindCode,
  getBindCodeStatus,
  consumeBindCode,
  listBindingsForUser,
  upsertBinding
} from "../src/bindings.mjs";

describe("S2 bind codes + S3 bindings", () => {
  it("creates a code, pending then verified after consume", async () => {
    const kv = createMemoryKv();
    const db = createMemoryDb();
    const { code } = await createBindCode(kv, {
      userId: "user-1",
      channel: "wechat_oa",
      purpose: "wechat_bind"
    });
    assert.match(code, /^[0-9A-Z]{6}$/);

    const pending = await getBindCodeStatus(kv, code);
    assert.equal(pending.status, "pending");

    const result = await consumeBindCode(kv, db, {
      code,
      openid: "openid-abc",
      channel: "wechat_oa"
    });
    assert.equal(result.ok, true);
    assert.equal(result.userId, "user-1");

    const bindings = await listBindingsForUser(db, "user-1");
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].externalId, "openid-abc");
    assert.equal(bindings[0].status, "verified");

    // code one-time
    const again = await consumeBindCode(kv, db, {
      code,
      openid: "openid-abc",
      channel: "wechat_oa"
    });
    assert.equal(again.ok, false);
  });

  it("rejects openid already bound to another user", async () => {
    const db = createMemoryDb();
    const first = await upsertBinding(db, {
      userId: "user-a",
      channel: "wechat_oa",
      externalId: "oid-1"
    });
    assert.equal(first.ok, true);

    const second = await upsertBinding(db, {
      userId: "user-b",
      channel: "wechat_oa",
      externalId: "oid-1"
    });
    assert.equal(second.ok, false);
    assert.match(second.error, /another user/i);
  });

  it("expires unknown codes", async () => {
    const kv = createMemoryKv();
    const st = await getBindCodeStatus(kv, "NOPE12");
    assert.equal(st.status, "expired");
  });
});
