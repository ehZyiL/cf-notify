import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deliverToChannel } from "../src/channels/index.mjs";
import { sendWechatCustomText } from "../src/channels/wechat-send.mjs";
import { createMemoryDb } from "../src/sqlite-d1.mjs";

describe("WeChat customer-service text delivery", () => {
  it("uses the fixed-IP custom message endpoint", async () => {
    const originalFetch = globalThis.fetch;
    let request;
    globalThis.fetch = async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return Response.json({ ok: true, msgid: "wx-message-1" });
    };
    try {
      const result = await sendWechatCustomText(
        {
          EGRESS_BASE_URL: "https://egress.example/",
          EGRESS_SHARED_SECRET: "shared-secret"
        },
        { openid: "openid-1", text: "Plain text", deliveryId: "delivery-1" }
      );

      assert.deepEqual(result, { ok: true, providerMsgId: "wx-message-1" });
      assert.equal(request.url, "https://egress.example/wechat/custom/send");
      assert.equal(request.init.headers["X-Delivery-Id"], "delivery-1");
      assert.deepEqual(request.body, { openid: "openid-1", text: "Plain text" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("selects custom text mode without resolving a template", async () => {
    let args;
    const result = await deliverToChannel(
      { db: createMemoryDb(), WECHAT_SEND_MODE: "custom_text" },
      {
        channel: "wechat_oa",
        binding: { externalId: "openid-2" },
        event: { eventType: "system.test", deliveryId: "delivery-2" },
        payload: {
          title: "Production test",
          body: "Customer-service text",
          url: "https://example.com/result",
          data: {}
        }
      },
      {
        sendWechat: async (_env, input) => {
          args = input;
          return { ok: true, providerMsgId: "wx-message-2" };
        }
      }
    );

    assert.deepEqual(result, { ok: true, providerMsgId: "wx-message-2" });
    assert.deepEqual(args, {
      openid: "openid-2",
      text: "Production test\nCustomer-service text\nhttps://example.com/result",
      deliveryId: "delivery-2"
    });
  });
});
