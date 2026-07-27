import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryDb } from "../src/sqlite-d1.mjs";
import {
  getEffectiveNotificationSettings,
  requireServiceIdentity,
  resolveNotificationTargets
} from "../src/notification-directory.mjs";

describe("cf-auth notification directory", () => {
  it("authenticates cfk API keys through the named RPC entrypoint", async () => {
    const calls = [];
    const env = {
      db: createMemoryDb(),
      NOTIFICATION_DIRECTORY_MODE: "rpc",
      authService: {
        async verifyServiceApiKey(rawKey) {
          calls.push(rawKey);
          return {
            valid: true,
            keyId: "key-1",
            serviceId: "xy-erp",
            scopes: ["notifications.settings.read"]
          };
        }
      }
    };
    const request = new Request("https://notify.example.com/v1/users/u/settings", {
      headers: { Authorization: "Bearer cfk_live_secret" }
    });

    const identity = await requireServiceIdentity(env, request, {
      scope: "notifications.settings.read"
    });

    assert.deepEqual(calls, ["cfk_live_secret"]);
    assert.deepEqual(identity, {
      clientId: "key-1",
      serviceId: "xy-erp",
      name: "key-1",
      scopes: ["notifications.settings.read"]
    });
  });

  it("rejects missing scopes returned by cf-auth", async () => {
    const env = {
      NOTIFICATION_DIRECTORY_MODE: "rpc",
      authService: {
        async verifyServiceApiKey() {
          return { valid: true, keyId: "key-1", serviceId: "xy-erp", scopes: [] };
        }
      }
    };
    const request = new Request("https://notify.example.com/v1/notifications", {
      headers: { Authorization: "Bearer cfk_live_secret" }
    });

    await assert.rejects(
      () => requireServiceIdentity(env, request, { scope: "notifications.send" }),
      (error) => error.status === 403
    );
  });

  it("whitelists the public effective-settings response", async () => {
    const env = {
      NOTIFICATION_DIRECTORY_MODE: "rpc",
      authService: {
        async getEffectiveNotificationSettings(input) {
          assert.deepEqual(input, {
            serviceId: "xy-erp",
            userId: "usr_1",
            eventType: "order.approved"
          });
          return {
            userId: "usr_1",
            serviceId: "xy-erp",
            enabled: true,
            eventType: "order.approved",
            channels: [{
              channel: "wechat_oa",
              available: true,
              enabled: true,
              maskedTarget: "wx***1234",
              openid: "must-not-leak",
              address: "must-not-leak"
            }],
            quietHours: { timezone: "Asia/Shanghai", start: "22:00", end: "08:00" },
            version: "v1",
            identifierCiphertext: "must-not-leak"
          };
        }
      }
    };

    const settings = await getEffectiveNotificationSettings(env, {
      serviceId: "xy-erp",
      userId: "usr_1",
      eventType: "order.approved"
    });

    assert.deepEqual(settings, {
      userId: "usr_1",
      serviceId: "xy-erp",
      enabled: true,
      eventType: "order.approved",
      channels: [{
        channel: "wechat_oa",
        available: true,
        enabled: true,
        maskedTarget: "wx***1234"
      }],
      quietHours: { timezone: "Asia/Shanghai", start: "22:00", end: "08:00" },
      version: "v1"
    });
  });

  it("normalizes a recipient removed before delivery into a permanent skip", async () => {
    const env = {
      NOTIFICATION_DIRECTORY_MODE: "rpc",
      authService: {
        async resolveNotificationTargets() {
          return null;
        }
      }
    };

    const resolution = await resolveNotificationTargets(env, {
      serviceId: "xy-erp",
      userId: "usr_removed",
      eventType: "order.approved"
    });

    assert.deepEqual(resolution, {
      decisionVersion: null,
      targets: [],
      deferUntil: null,
      skipReason: "recipient_not_available"
    });
  });
});
