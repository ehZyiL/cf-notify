import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryKv } from "../src/memory-kv.mjs";
import { consumeLimit } from "../src/rate-limit.mjs";

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
});
