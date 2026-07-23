import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryDb } from "../src/sqlite-d1.mjs";
import { resolveTemplate, upsertChannelApp, getChannelApp } from "../src/templates.mjs";
import { upsertBinding } from "../src/bindings.mjs";
import { sendNotification } from "../src/send.mjs";

describe("S8 template map", () => {
  it("maps event fields from channel_apps", async () => {
    const map = {
      "worklog.failed": {
        template_id: "TPL_FAIL",
        fields: { thing1: "title", thing2: "body" }
      }
    };
    const resolved = resolveTemplate(JSON.stringify(map), "worklog.failed", {
      title: "失败标题",
      body: "失败详情"
    });
    assert.equal(resolved.templateId, "TPL_FAIL");
    assert.equal(resolved.templateData.thing1.value, "失败标题");
  });

  it("send uses template map from DB", async () => {
    const db = createMemoryDb();
    await upsertChannelApp(db, {
      channel: "wechat_oa",
      name: "mp",
      templateMap: {
        test: { template_id: "TPL_TEST", fields: { thing1: "title", thing2: "body" } }
      }
    });
    await upsertBinding(db, { userId: "u1", channel: "wechat_oa", externalId: "oid" });
    let called = null;
    await sendNotification(
      { db },
      { user_id: "u1", event: "test", title: "Hello", body: "World" },
      { clientId: "c", serviceId: "s" },
      {
        sendWechat: async (_e, args) => {
          called = args;
          return { ok: true, providerMsgId: "1" };
        }
      }
    );
    assert.equal(called.templateId, "TPL_TEST");
    assert.equal(called.data.thing1.value, "Hello");
    const app = await getChannelApp(db, "wechat_oa");
    assert.ok(app);
  });
});
