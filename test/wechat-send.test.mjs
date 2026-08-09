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

  it("does not retry an account capability rejection", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json(
      { ok: false, error: "api unauthorized", errcode: 48001 },
      { status: 403 }
    );
    try {
      const result = await sendWechatCustomText(
        {
          EGRESS_BASE_URL: "https://egress.example",
          EGRESS_SHARED_SECRET: "shared-secret"
        },
        { openid: "openid-3", text: "Plain text" }
      );

      assert.deepEqual(result, {
        ok: false,
        retryable: false,
        outcomeUnknown: false,
        errorCode: "wechat_48001",
        error: "api unauthorized",
        providerMsgId: null
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not retry an invalid OpenID", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json(
      { ok: false, error: "invalid openid", errcode: 40003 },
      { status: 422 }
    );
    try {
      const result = await sendWechatCustomText(
        {
          EGRESS_BASE_URL: "https://egress.example",
          EGRESS_SHARED_SECRET: "shared-secret"
        },
        { openid: "invalid-openid", text: "Plain text" }
      );

      assert.equal(result.retryable, false);
      assert.equal(result.errorCode, "wechat_40003");
      assert.equal(result.error, "invalid openid");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("truncates customer-service text to 2048 UTF-8 bytes", async () => {
    const originalFetch = globalThis.fetch;
    let captured;
    globalThis.fetch = async (_url, init) => {
      captured = JSON.parse(init.body);
      return Response.json({ ok: true, msgid: "wx-trunc" });
    };
    try {
      // 700 CJK chars = 2100 bytes > 2048 byte budget
      await sendWechatCustomText(
        {
          EGRESS_BASE_URL: "https://egress.example",
          EGRESS_SHARED_SECRET: "shared-secret"
        },
        { openid: "openid-trunc", text: "字".repeat(700) }
      );
      assert.equal(Buffer.byteLength(captured.text, "utf8") <= 2048, true);
      // Never split a multibyte char: trailing byte is a full char boundary
      assert.equal(captured.text.endsWith("字"), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
