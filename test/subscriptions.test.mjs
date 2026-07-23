import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryDb } from "../src/sqlite-d1.mjs";
import { isSubscribed, upsertSubscription, listSubscriptions } from "../src/subscriptions.mjs";
import { upsertBinding } from "../src/bindings.mjs";
import { sendNotification } from "../src/send.mjs";

describe("S7 subscriptions", () => {
  it("defaults to subscribed when no rows", async () => {
    const db = createMemoryDb();
    assert.equal(await isSubscribed(db, { userId: "u1", serviceId: "xy-erp", eventType: "x" }), true);
  });

  it("respects enabled subscription rows", async () => {
    const db = createMemoryDb();
    await upsertSubscription(db, {
      userId: "u1",
      serviceId: "xy-erp",
      eventType: "worklog.failed",
      enabled: true
    });
    assert.equal(
      await isSubscribed(db, { userId: "u1", serviceId: "xy-erp", eventType: "worklog.failed" }),
      true
    );
    assert.equal(
      await isSubscribed(db, { userId: "u1", serviceId: "xy-erp", eventType: "other" }),
      false
    );
  });

  it("send skips when not subscribed", async () => {
    const db = createMemoryDb();
    await upsertBinding(db, { userId: "u1", channel: "wechat_oa", externalId: "o1" });
    await upsertSubscription(db, {
      userId: "u1",
      serviceId: "xy-erp",
      eventType: "only-this",
      enabled: true
    });
    const result = await sendNotification(
      { db },
      { user_id: "u1", service_id: "xy-erp", event: "other", title: "t", body: "b" },
      { clientId: "c", serviceId: "xy-erp" },
      { sendWechat: async () => ({ ok: true, providerMsgId: "x" }) }
    );
    assert.equal(result.summary, "not_subscribed");
    assert.equal(result.results[0].error, "not_subscribed");
  });

  it("lists subscriptions for user", async () => {
    const db = createMemoryDb();
    await upsertSubscription(db, {
      userId: "u1",
      serviceId: "xy-erp",
      eventType: "*",
      channels: ["wechat_oa"]
    });
    const list = await listSubscriptions(db, "u1");
    assert.equal(list.length, 1);
    assert.equal(list[0].eventType, "*");
  });
});
