import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deliverToChannel } from "../src/channels/index.mjs";
import { sendWecomApplicationMessage } from "../src/channels/wecom-send.mjs";
import { createMemoryDb } from "../src/sqlite-d1.mjs";

const ENV = {
  EGRESS_BASE_URL: "https://egress.example/",
  EGRESS_SHARED_SECRET: "shared-secret"
};

async function withFetch(mock, callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("WeCom application message delivery", () => {
  it("sends text through the fixed-IP egress endpoint", async () => {
    let request;
    await withFetch(async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return Response.json({ ok: true, msgid: "wecom-msg-1" });
    }, async () => {
      const result = await sendWecomApplicationMessage(ENV, {
        userId: "zhangsan",
        title: "任务完成",
        body: "同步已完成",
        deliveryId: "delivery-1"
      });
      assert.deepEqual(result, { ok: true, providerMsgId: "wecom-msg-1" });
    });

    assert.equal(request.url, "https://egress.example/wecom/app/send");
    assert.equal(request.init.headers["X-Egress-Key"], "shared-secret");
    assert.equal(request.init.headers["X-Delivery-Id"], "delivery-1");
    assert.deepEqual(request.body, {
      userId: "zhangsan",
      msgType: "text",
      content: "任务完成\n同步已完成"
    });
  });

  it("uses textcard for an HTTPS detail URL", async () => {
    let body;
    await withFetch(async (_url, init) => {
      body = JSON.parse(init.body);
      return Response.json({ ok: true });
    }, () => sendWecomApplicationMessage(ENV, {
      userId: "lisi",
      title: "审批待办",
      body: "单号 SO-001",
      url: "https://erp.example.com/orders/SO-001"
    }));

    assert.deepEqual(body, {
      userId: "lisi",
      msgType: "textcard",
      title: "审批待办",
      description: "单号 SO-001",
      url: "https://erp.example.com/orders/SO-001"
    });
  });

  it("rejects multi-user and all-user targets before calling egress", async () => {
    let calls = 0;
    await withFetch(async () => {
      calls += 1;
      return Response.json({ ok: true });
    }, async () => {
      for (const userId of ["zhangsan|lisi", "@all", "", "a".repeat(65), "user\nother"]) {
        const result = await sendWecomApplicationMessage(ENV, { userId, body: "test" });
        assert.equal(result.ok, false);
        assert.equal(result.retryable, false);
        assert.equal(result.errorCode, "wecom_invalid_target");
      }
    });
    assert.equal(calls, 0);
  });

  it("classifies temporary and permanent provider failures", async () => {
    await withFetch(async () => Response.json(
      { ok: false, errcode: -1, errmsg: "system busy" },
      { status: 503 }
    ), async () => {
      const temporary = await sendWecomApplicationMessage(ENV, {
        userId: "zhangsan",
        body: "test"
      });
      assert.equal(temporary.retryable, true);
      assert.equal(temporary.errorCode, "wecom_-1");
    });

    await withFetch(async () => Response.json(
      { ok: false, errcode: 60111, errmsg: "user not found" },
      { status: 422 }
    ), async () => {
      const permanent = await sendWecomApplicationMessage(ENV, {
        userId: "missing-user",
        body: "test"
      });
      assert.equal(permanent.retryable, false);
      assert.equal(permanent.errorCode, "wecom_60111");
    });
  });

  it("maps a resolved binding through the channel adapter", async () => {
    let input;
    const result = await deliverToChannel(
      { db: createMemoryDb() },
      {
        channel: "wecom",
        binding: { externalId: "wangwu" },
        event: { deliveryId: "delivery-2", eventType: "order.approved" },
        payload: {
          title: "审批通过",
          body: "订单已通过",
          url: "https://erp.example.com/order/1",
          data: {}
        }
      },
      {
        async sendWecom(_env, value) {
          input = value;
          return { ok: true, providerMsgId: "wecom-msg-2" };
        }
      }
    );

    assert.deepEqual(result, { ok: true, providerMsgId: "wecom-msg-2" });
    assert.deepEqual(input, {
      userId: "wangwu",
      title: "审批通过",
      body: "订单已通过",
      url: "https://erp.example.com/order/1",
      deliveryId: "delivery-2"
    });
  });
});
