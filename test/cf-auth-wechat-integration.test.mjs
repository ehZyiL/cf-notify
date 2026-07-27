import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { consumeNotificationBindingChallenge, createNotificationBindingChallenge, updateNotificationBindingStatusByIdentifier } from "../../cf-auth/src/notification-bindings.mjs";
import { getEffectiveNotificationSettings as getAuthSettings, resolveNotificationTargets as resolveAuthTargets, upsertNotificationEventType, validateNotificationPayload } from "../../cf-auth/src/notification-preferences.mjs";
import { createService } from "../../cf-auth/src/services.mjs";
import { createMemoryDb as createAuthDb } from "../../cf-auth/src/sqlite-d1.mjs";
import { createUser } from "../../cf-auth/src/users.mjs";
import { handleWechatMessage } from "../src/channels/wechat-callback.mjs";
import { createMemoryKv } from "../src/memory-kv.mjs";
import { deliverNotification, dispatchEvent, ingestNotificationEvent, listEventDeliveries } from "../src/reliable-delivery.mjs";
import { createMemoryDb as createNotifyDb } from "../src/sqlite-d1.mjs";

const secrets = {
  encryptionKey: "integration-notification-encryption-key-at-least-32-bytes",
  identifierHmacKey: "integration-notification-hmac-key-at-least-32-bytes",
  keyVersion: 1
};

class MemoryQueue {
  constructor() {
    this.messages = [];
  }

  async send(body) {
    this.messages.push(body);
  }
}

async function fixture() {
  const authDb = createAuthDb();
  const user = await createUser(authDb, {
    email: "wechat-integration@example.com",
    password: "password1"
  });
  await createService(authDb, { id: "orders", name: "Orders" });
  await authDb
    .prepare(
      `INSERT INTO user_services (user_id, service_id, role, created_at)
       VALUES (?, 'orders', 'user', ?)`
    )
    .bind(user.id, new Date().toISOString())
    .run();
  await upsertNotificationEventType(authDb, "orders", {
    eventType: "order.approved",
    displayName: "Order approved",
    category: "orders",
    allowedChannels: ["wechat_oa"],
    defaultChannels: ["wechat_oa"],
    payloadSchema: {}
  });
  const challenge = await createNotificationBindingChallenge(authDb, {
    userId: user.id,
    channel: "wechat_oa",
    providerAccountId: "wechat-main"
  });
  const authService = {
    getEffectiveNotificationSettings(input) {
      return getAuthSettings(authDb, input);
    },
    async authorizeNotificationEvent(input) {
      const settings = await getAuthSettings(authDb, input);
      if (!settings.ok) return settings;
      try {
        validateNotificationPayload(settings.payloadSchema, input.data);
        return settings;
      } catch (error) {
        return { ok: false, error: "invalid_payload", message: error.message };
      }
    },
    resolveNotificationTargets(input) {
      return resolveAuthTargets(authDb, secrets.encryptionKey, input);
    },
    consumeBindingChallenge(input) {
      return consumeNotificationBindingChallenge(authDb, secrets, input);
    },
    updateBindingStatus(input) {
      return updateNotificationBindingStatusByIdentifier(authDb, secrets, input);
    }
  };
  return {
    authDb,
    user,
    challenge,
    env: {
      db: createNotifyDb(),
      kv: createMemoryKv(),
      authService,
      dispatchQueue: new MemoryQueue(),
      deliveryQueue: new MemoryQueue(),
      NOTIFICATION_DIRECTORY_MODE: "rpc",
      WECHAT_PROVIDER_ACCOUNT_ID: "wechat-main"
    }
  };
}

describe("cf-auth to cf-notify WeChat contract", () => {
  it("binds through the provider callback and resolves openid only in delivery memory", async () => {
    const { authDb, user, challenge, env } = await fixture();
    assert.match(challenge.token, /^[0-9A-Z]{8}$/);
    const openid = `openid-${crypto.randomUUID()}`;
    const xml = `<xml>
      <ToUserName><![CDATA[official-account]]></ToUserName>
      <FromUserName><![CDATA[${openid}]]></FromUserName>
      <CreateTime>1710000000</CreateTime>
      <MsgType><![CDATA[text]]></MsgType>
      <Content><![CDATA[${challenge.token}]]></Content>
    </xml>`;
    const callback = await handleWechatMessage(env, xml);
    assert.match(await callback.text(), /绑定成功/);

    const authBinding = await authDb
      .prepare("SELECT identifier_ciphertext FROM notification_channel_bindings WHERE user_id = ?")
      .bind(user.id)
      .first();
    assert.match(authBinding.identifier_ciphertext, /^aesgcm\.v1\./);
    assert.doesNotMatch(JSON.stringify(authBinding), new RegExp(openid));

    const accepted = await ingestNotificationEvent(
      env,
      {
        userId: user.id,
        type: "order.approved",
        title: "Approved",
        body: "Order SO-1 was approved",
        data: { orderNo: "SO-1" }
      },
      { clientId: "orders-test", serviceId: "orders" },
      "orders:SO-1:approved"
    );
    await dispatchEvent(env, accepted.eventId);
    const [delivery] = await listEventDeliveries(env.db, accepted.eventId);
    let sentTo = null;
    await deliverNotification(env, delivery.id, {
      sendWechat: async (_env, input) => {
        sentTo = input.openid;
        return { ok: true, providerMsgId: "wechat-message-1" };
      }
    });
    assert.equal(sentTo, openid);

    const notifyRows = await env.db.prepare("SELECT * FROM notification_deliveries").all();
    assert.doesNotMatch(JSON.stringify(notifyRows.results), new RegExp(openid));
  });
});
