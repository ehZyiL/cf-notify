import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createWechatClient } from "../egress/wechat-client.mjs";

function jsonResponse(data, init) {
  return Response.json(data, init);
}

describe("WeChat fixed-IP egress client", () => {
  it("caches the access token and sends a custom text message", async () => {
    const requests = [];
    const client = createWechatClient({
      appId: "wx-app",
      appSecret: "app-secret",
      async fetchImpl(url, init = {}) {
        requests.push({ url, init });
        if (url.includes("/cgi-bin/token?")) {
          return jsonResponse({ access_token: "token-1", expires_in: 7200 });
        }
        return jsonResponse({ errcode: 0, errmsg: "ok", msgid: "msg-sent" });
      }
    });

    const result = await client.callApi("/cgi-bin/message/custom/send", {
      touser: "openid-1",
      msgtype: "text",
      text: { content: "hello" }
    });
    assert.equal(result.msgid, "msg-sent");
    assert.equal(
      requests.filter((r) => r.url.includes("/cgi-bin/token?")).length,
      1
    );
    const send = requests.find((r) => r.url.includes("/cgi-bin/message/custom/send"));
    assert.deepEqual(JSON.parse(send.init.body), {
      touser: "openid-1",
      msgtype: "text",
      text: { content: "hello" }
    });
  });

  it("refreshes an invalid token once and retries the same payload", async () => {
    let tokenCalls = 0;
    const sendBodies = [];
    const client = createWechatClient({
      appId: "wx-app",
      appSecret: "app-secret",
      async fetchImpl(url, init = {}) {
        if (url.includes("/cgi-bin/token?")) {
          tokenCalls += 1;
          return jsonResponse({
            access_token: `token-${tokenCalls}`,
            expires_in: 7200
          });
        }
        sendBodies.push(init.body);
        if (sendBodies.length === 1) {
          return jsonResponse({ errcode: 42001, errmsg: "access_token expired" });
        }
        return jsonResponse({ errcode: 0, errmsg: "ok", msgid: "msg-refreshed" });
      }
    });

    const result = await client.callApi("/cgi-bin/message/custom/send", {
      touser: "openid-1",
      msgtype: "text",
      text: { content: "retry me" }
    });

    assert.equal(result.msgid, "msg-refreshed");
    assert.equal(tokenCalls, 2);
    assert.equal(sendBodies.length, 2);
    assert.equal(sendBodies[0], sendBodies[1]);
  });

  it("does not retry more than once on repeated token errors", async () => {
    let tokenCalls = 0;
    const client = createWechatClient({
      appId: "wx-app",
      appSecret: "app-secret",
      async fetchImpl(url) {
        if (url.includes("/cgi-bin/token?")) {
          tokenCalls += 1;
          return jsonResponse({ access_token: `t-${tokenCalls}`, expires_in: 7200 });
        }
        return jsonResponse({ errcode: 40014, errmsg: "invalid access_token" });
      }
    });

    await assert.rejects(
      () => client.callApi("/cgi-bin/message/custom/send", { touser: "x" }),
      (error) => error.errcode === 40014 && error.statusCode === 503
    );
    assert.equal(tokenCalls, 2);
  });

  it("classifies a permanent capability error as 422", async () => {
    const client = createWechatClient({
      appId: "wx-app",
      appSecret: "app-secret",
      async fetchImpl(url) {
        if (url.includes("/cgi-bin/token?")) {
          return jsonResponse({ access_token: "t-1", expires_in: 7200 });
        }
        return jsonResponse({ errcode: 43004, errmsg: "require subscribe" });
      }
    });

    await assert.rejects(
      () => client.callApi("/cgi-bin/message/custom/send", { touser: "x" }),
      (error) => error.errcode === 43004 && error.statusCode === 422
    );
  });
});
