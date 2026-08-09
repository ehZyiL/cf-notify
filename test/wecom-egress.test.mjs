import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createWecomClient } from "../egress/wecom-client.mjs";

function jsonResponse(data, init) {
  return Response.json(data, init);
}

describe("WeCom fixed-IP egress client", () => {
  it("caches the access token and builds a single-user application message", async () => {
    const requests = [];
    const client = createWecomClient({
      corpId: "ww-corp",
      appSecret: "app-secret",
      agentId: "1000002",
      async fetchImpl(url, init = {}) {
        requests.push({ url, init });
        if (url.includes("/gettoken?")) {
          return jsonResponse({ errcode: 0, access_token: "token-1", expires_in: 7200 });
        }
        return jsonResponse({ errcode: 0, errmsg: "ok", msgid: `msg-${requests.length}` });
      }
    });

    await client.sendApplicationMessage({
      userId: "zhangsan",
      msgType: "text",
      content: "任务完成"
    });
    await client.sendApplicationMessage({
      userId: "lisi",
      msgType: "textcard",
      title: "审批待办",
      description: "请处理单号 SO-001",
      url: "https://erp.example.com/orders/SO-001"
    });

    assert.equal(requests.filter((request) => request.url.includes("/gettoken?")).length, 1);
    const sends = requests.filter((request) => request.url.includes("/message/send?"));
    assert.equal(sends.length, 2);
    assert.deepEqual(JSON.parse(sends[0].init.body), {
      touser: "zhangsan",
      msgtype: "text",
      agentid: 1000002,
      text: { content: "任务完成" },
      safe: 0,
      enable_id_trans: 0,
      enable_duplicate_check: 1,
      duplicate_check_interval: 1800
    });
    assert.deepEqual(JSON.parse(sends[1].init.body).textcard, {
      title: "审批待办",
      description: "请处理单号 SO-001",
      url: "https://erp.example.com/orders/SO-001",
      btntxt: "查看详情"
    });
  });

  it("builds a markdown application message", async () => {
    const requests = [];
    const client = createWecomClient({
      corpId: "ww-corp",
      appSecret: "app-secret",
      agentId: "1000002",
      async fetchImpl(url, init = {}) {
        requests.push({ url, init });
        if (url.includes("/gettoken?")) {
          return jsonResponse({ errcode: 0, access_token: "token-1", expires_in: 7200 });
        }
        return jsonResponse({ errcode: 0, errmsg: "ok", msgid: "msg-md" });
      }
    });

    await client.sendApplicationMessage({
      userId: "zhangsan",
      msgType: "markdown",
      content: "**任务完成**\n\n同步已完成"
    });

    const send = requests.find((r) => r.url.includes("/message/send?"));
    assert.deepEqual(JSON.parse(send.init.body), {
      touser: "zhangsan",
      msgtype: "markdown",
      agentid: 1000002,
      markdown: { content: "**任务完成**\n\n同步已完成" },
      safe: 0,
      enable_id_trans: 0,
      enable_duplicate_check: 1,
      duplicate_check_interval: 1800
    });
  });

  it("rejects text content exceeding the 2048 byte limit by byte length, not characters", async () => {
    const client = createWecomClient({
      corpId: "ww-corp",
      appSecret: "app-secret",
      agentId: "1000002",
      async fetchImpl() {
        throw new Error("provider must not be called");
      }
    });

    // 700 CJK chars = 2100 bytes > 2048 byte budget.
    // Old char-based check (text.length > 2000) would have let this through.
    await assert.rejects(
      () => client.sendApplicationMessage({
        userId: "zhangsan",
        msgType: "text",
        content: "字".repeat(700)
      }),
      (error) => error.statusCode === 400
    );
  });

  it("refreshes an invalid token once and retries the same payload", async () => {
    let tokenCalls = 0;
    const sendBodies = [];
    const client = createWecomClient({
      corpId: "ww-corp",
      appSecret: "app-secret",
      agentId: "1000002",
      async fetchImpl(url, init = {}) {
        if (url.includes("/gettoken?")) {
          tokenCalls += 1;
          return jsonResponse({
            errcode: 0,
            access_token: `token-${tokenCalls}`,
            expires_in: 7200
          });
        }
        sendBodies.push(init.body);
        if (sendBodies.length === 1) {
          return jsonResponse({ errcode: 40014, errmsg: "invalid access_token" });
        }
        return jsonResponse({ errcode: 0, errmsg: "ok", msgid: "msg-refreshed" });
      }
    });

    const result = await client.sendApplicationMessage({
      userId: "zhangsan",
      msgType: "text",
      content: "retry me"
    });

    assert.equal(result.msgid, "msg-refreshed");
    assert.equal(tokenCalls, 2);
    assert.equal(sendBodies.length, 2);
    assert.equal(sendBodies[0], sendBodies[1]);
  });

  it("rejects unsafe recipients and invalid textcard URLs", async () => {
    const client = createWecomClient({
      corpId: "ww-corp",
      appSecret: "app-secret",
      agentId: "1000002",
      async fetchImpl() {
        throw new Error("provider must not be called");
      }
    });

    await assert.rejects(
      () => client.sendApplicationMessage({ userId: "zhangsan|lisi", content: "test" }),
      (error) => error.statusCode === 400
    );
    await assert.rejects(
      () => client.sendApplicationMessage({ userId: "@all", content: "test" }),
      (error) => error.statusCode === 400
    );
    await assert.rejects(
      () => client.sendApplicationMessage({ userId: "a".repeat(65), content: "test" }),
      (error) => error.statusCode === 400
    );
    await assert.rejects(
      () => client.sendApplicationMessage({
        userId: "zhangsan",
        msgType: "textcard",
        title: "unsafe",
        description: "unsafe",
        url: "http://example.com"
      }),
      (error) => error.statusCode === 400
    );
  });

  it("classifies invalid users as permanent provider failures", async () => {
    const client = createWecomClient({
      corpId: "ww-corp",
      appSecret: "app-secret",
      agentId: "1000002",
      async fetchImpl(url) {
        if (url.includes("/gettoken?")) {
          return jsonResponse({ errcode: 0, access_token: "token-1", expires_in: 7200 });
        }
        return jsonResponse({ errcode: 0, errmsg: "ok", invaliduser: "unknown-user" });
      }
    });

    await assert.rejects(
      () => client.sendApplicationMessage({
        userId: "unknown-user",
        msgType: "text",
        content: "test"
      }),
      (error) => error.errcode === 60111 && error.statusCode === 422
    );
  });
});
