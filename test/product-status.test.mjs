import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getChannelCapability,
  listChannelCapabilities
} from "../src/channel-capabilities.mjs";
import { createMemoryKv } from "../src/memory-kv.mjs";
import { getAdminReadiness, getProductRuntime } from "../src/product-status.mjs";
import { createMemoryDb } from "../src/sqlite-d1.mjs";

function readyEnv(overrides = {}) {
  return {
    db: createMemoryDb(),
    kv: createMemoryKv(),
    authService: {},
    dispatchQueue: { send: async () => {} },
    deliveryQueue: { send: async () => {} },
    NOTIFICATION_DIRECTORY_MODE: "rpc",
    WECHAT_TOKEN: "wechat-token",
    WECHAT_SEND_MODE: "custom_text",
    WECOM_CALLBACK_TOKEN: "wecom-token",
    WECOM_ENCODING_AES_KEY: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
    WECOM_CORP_ID: "ww-test-corp",
    WECOM_QRCODE_URL: "https://notify.example.com/wecom.png",
    EGRESS_BASE_URL: "https://egress.example.com",
    EGRESS_SHARED_SECRET: "egress-secret",
    egressFetch: async () => new Response(null, { status: 204 }),
    ...overrides
  };
}

describe("channel capability model", () => {
  it("separates implementation, enrollment, callback, and delivery readiness", () => {
    const env = readyEnv();
    const channels = listChannelCapabilities(env, [
      { channel: "wecom", enabled: true },
      { channel: "wechat_oa", enabled: true },
      { channel: "telegram", enabled: true }
    ]);

    const wecom = channels.find((item) => item.channel === "wecom");
    assert.equal(wecom.status, "ready");
    assert.equal(wecom.bindable, true);
    assert.equal(wecom.sendable, true);
    assert.equal(wecom.mode, "application_message");

    const wechat = channels.find((item) => item.channel === "wechat_oa");
    assert.equal(wechat.available, true);
    assert.deepEqual(wechat.limitations, ["interaction_window_required"]);

    const telegram = channels.find((item) => item.channel === "telegram");
    assert.equal(telegram.implemented, false);
    assert.equal(telegram.available, false);
    assert.equal(telegram.reason, "not_implemented");
  });

  it("carries binding-flow copy and default provider accounts for the account center", () => {
    const env = readyEnv({
      WECHAT_PROVIDER_ACCOUNT_ID: "wechat-main",
      WECOM_PROVIDER_ACCOUNT_ID: "wecom-main"
    });
    const channels = listChannelCapabilities(env, [
      {
        channel: "wechat_oa",
        enabled: true,
        accountName: "ehzyil的公众号",
        description: "扫码关注后发送绑定码。",
        imageUrl: "https://notify.example.com/wechat.png",
        actionUrl: "https://mp.weixin.qq.com/x",
        actionLabel: "打开公众号"
      },
      { channel: "wecom", enabled: true }
    ]);

    const wechat = channels.find((item) => item.channel === "wechat_oa");
    assert.equal(wechat.providerAccountId, "wechat-main");
    assert.equal(wechat.eyebrow, "WeChat Official Account");
    assert.equal(wechat.accountLabel, "微信账号");
    assert.equal(wechat.emptyTitle, "尚未绑定公众号");
    assert.equal(wechat.openStep, "在微信中打开并关注通知公众号。");
    assert.equal(wechat.sendStep, "将绑定码原样发送给公众号。");
    assert.equal(wechat.accountName, "ehzyil的公众号");
    assert.equal(wechat.description, "扫码关注后发送绑定码。");
    assert.equal(wechat.imageUrl, "https://notify.example.com/wechat.png");
    assert.equal(wechat.actionUrl, "https://mp.weixin.qq.com/x");
    assert.equal(wechat.actionLabel, "打开公众号");

    const wecom = channels.find((item) => item.channel === "wecom");
    assert.equal(wecom.providerAccountId, "wecom-main");
    assert.equal(wecom.eyebrow, "WeCom");
    assert.equal(wecom.readyTitle, "企业微信通知已就绪");
    assert.equal(wecom.sendStep, "将绑定码原样发送给应用。");
  });

  it("documents the dead-letter path for both reliable queues", async () => {
    const readiness = await getAdminReadiness(readyEnv({
      egressFetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    }));
    assert.equal(readiness.checks.dispatchQueue.status, "configured");
    assert.equal(readiness.checks.dispatchQueue.detail, "retries → cf-notify-dispatch-dlq");
    assert.equal(readiness.checks.deliveryQueue.status, "configured");
    assert.equal(readiness.checks.deliveryQueue.detail, "retries → cf-notify-delivery-dlq");
  });

  it("reports the actionable reason for degraded channels", () => {
    const missingCallback = getChannelCapability(
      readyEnv({ WECOM_CALLBACK_TOKEN: "" }),
      { channel: "wecom", enabled: true }
    );
    assert.equal(missingCallback.status, "degraded");
    assert.equal(missingCallback.reason, "callback_not_configured");

    const invalidMode = getChannelCapability(
      readyEnv({ WECHAT_SEND_MODE: "broadcast" }),
      { channel: "wechat_oa", enabled: true }
    );
    assert.equal(invalidMode.status, "degraded");
    assert.equal(invalidMode.reason, "unsupported_send_mode");
  });
});

describe("product runtime and readiness", () => {
  it("describes production ownership without exposing unsafe account URLs", async () => {
    const runtime = await getProductRuntime(readyEnv({
      CF_AUTH_ACCOUNT_URL: "javascript:alert(1)"
    }));
    assert.equal(runtime.directoryMode, "rpc");
    assert.equal(runtime.serviceCredentials.source, "cf-auth");
    assert.equal(runtime.serviceCredentials.localManagementEnabled, false);
    assert.equal(runtime.messaging.templateMappingEnabled, false);
    assert.equal(runtime.cfAuthAccountUrl, null);

    const credentialUrl = await getProductRuntime(readyEnv({
      CF_AUTH_ACCOUNT_URL: "https://user:password@auth.example.com/"
    }));
    assert.equal(credentialUrl.cfAuthAccountUrl, null);
  });

  it("reports healthy dependencies and degrades closed when bindings are missing", async () => {
    const healthy = await getAdminReadiness(readyEnv());
    assert.equal(healthy.ok, true);
    assert.equal(healthy.status, "healthy");
    assert.equal(healthy.checks.database.status, "ok");
    assert.equal(healthy.checks.egress.status, "ok");

    const local = await getAdminReadiness(readyEnv({
      NOTIFICATION_DIRECTORY_MODE: "local",
      authService: undefined
    }));
    assert.equal(local.ok, true);
    assert.equal(local.checks.notificationDirectory.status, "ok");

    const missingEgressSecret = await getAdminReadiness(readyEnv({
      EGRESS_SHARED_SECRET: ""
    }));
    assert.equal(missingEgressSecret.ok, false);
    assert.equal(missingEgressSecret.checks.egress.detail, "EGRESS_SHARED_SECRET is missing");

    const degraded = await getAdminReadiness({
      NOTIFICATION_DIRECTORY_MODE: "rpc",
      EGRESS_BASE_URL: "http://egress.example.com"
    });
    assert.equal(degraded.ok, false);
    assert.equal(degraded.status, "degraded");
    assert.equal(degraded.checks.database.status, "down");
    assert.equal(degraded.checks.kv.status, "down");
    assert.equal(degraded.checks.notificationDirectory.status, "down");
    assert.equal(degraded.checks.egress.status, "down");
  });
});
