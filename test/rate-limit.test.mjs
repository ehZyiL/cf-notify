import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryKv } from "../src/memory-kv.mjs";
import { consumeLimit, assertBindCodeAllowed } from "../src/rate-limit.mjs";

describe("S9 bind rate limit", () => {
  it("blocks after limit", async () => {
    const kv = createMemoryKv();
    const a = await consumeLimit(kv, "k", { limit: 2, windowSec: 60 });
    const b = await consumeLimit(kv, "k", { limit: 2, windowSec: 60 });
    const c = await consumeLimit(kv, "k", { limit: 2, windowSec: 60 });
    assert.equal(a.allowed, true);
    assert.equal(b.allowed, true);
    assert.equal(c.allowed, false);
  });

  it("limits bind codes per user", async () => {
    const kv = createMemoryKv();
    const req = new Request("https://n.example/api/bindings/code", {
      headers: { "CF-Connecting-IP": "9.9.9.9" }
    });
    for (let i = 0; i < 3; i++) {
      const r = await assertBindCodeAllowed(kv, "user-1", req);
      assert.equal(r, null);
    }
    const blocked = await assertBindCodeAllowed(kv, "user-1", req);
    assert.equal(blocked.status, 429);
  });
});
