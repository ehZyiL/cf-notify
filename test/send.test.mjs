import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryDb } from "../src/sqlite-d1.mjs";
import { upsertBinding } from "../src/bindings.mjs";
import { sendNotification, listLogs } from "../src/send.mjs";

describe("S5 send orchestration", () => {
  it("skips when user has no wechat binding", async () => {
    const db = createMemoryDb();
    const env = { db, EGRESS_BASE_URL: "https://egress.example", EGRESS_SHARED_SECRET: "k" };
    const result = await sendNotification(
      env,
      { user_id: "u1", event: "test", title: "t", body: "b" },
      { clientId: "c1", serviceId: "xy-erp" }
    );
    assert.equal(result.ok, true);
    assert.equal(result.results[0].status, "skipped");
    assert.equal(result.results[0].error, "not_bound");
    const logs = await listLogs(db, { userId: "u1" });
    assert.equal(logs[0].status, "skipped");
  });

  it("sends via mock egress when bound", async () => {
    const db = createMemoryDb();
    await upsertBinding(db, {
      userId: "u2",
      channel: "wechat_oa",
      externalId: "oid-2"
    });
    const env = { db };
    let called = null;
    const result = await sendNotification(
      env,
      {
        user_id: "u2",
        event: "worklog.failed",
        title: "失败",
        body: "详情",
        data: { template_id: "TPL1", template: { thing1: { value: "x" } } }
      },
      { clientId: "c1", serviceId: "xy-erp" },
      {
        sendWechat: async (_env, args) => {
          called = args;
          return { ok: true, providerMsgId: "mid-1" };
        }
      }
    );
    assert.equal(result.results[0].status, "sent");
    assert.equal(called.openid, "oid-2");
    assert.equal(called.templateId, "TPL1");
    const logs = await listLogs(db, { userId: "u2" });
    assert.equal(logs[0].status, "sent");
  });

  it("records failed send", async () => {
    const db = createMemoryDb();
    await upsertBinding(db, { userId: "u3", channel: "wechat_oa", externalId: "oid-3" });
    const result = await sendNotification(
      { db },
      { user_id: "u3", title: "t", body: "b" },
      { clientId: "c1", serviceId: "s" },
      { sendWechat: async () => ({ ok: false, error: "egress down" }) }
    );
    assert.equal(result.results[0].status, "failed");
    assert.match(result.results[0].error, /egress down/);
  });
});
