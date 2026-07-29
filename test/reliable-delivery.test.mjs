import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { upsertBinding, revokeBinding } from "../src/bindings.mjs";
import {
  deliverNotification,
  dispatchEvent,
  getEventStatusForService,
  ingestNotificationEvent,
  listEventDeliveries,
  processDeadLetter,
  processQueueBatch,
  reconcileQueues,
  retryDelivery,
  retryFailedDeliveries
} from "../src/reliable-delivery.mjs";
import { listLogs } from "../src/send.mjs";
import { createMemoryDb } from "../src/sqlite-d1.mjs";
import { upsertSubscription } from "../src/subscriptions.mjs";

class MemoryQueue {
  constructor() {
    this.messages = [];
    this.options = [];
    this.error = null;
  }

  async send(body, options) {
    if (this.error) throw this.error;
    this.messages.push(body);
    this.options.push(options || null);
  }
}

function makeEnv() {
  return {
    db: createMemoryDb(),
    dispatchQueue: new MemoryQueue(),
    deliveryQueue: new MemoryQueue()
  };
}

const client = { clientId: "client-a", serviceId: "service-a" };

async function createEvent(env, overrides = {}, key = "order:1") {
  return ingestNotificationEvent(
    env,
    {
      userId: "user-a",
      type: "order.approved",
      title: "Approved",
      body: "Order 1",
      ...overrides
    },
    client,
    key
  );
}

function fakeMessage(body) {
  return {
    id: crypto.randomUUID(),
    body,
    acked: false,
    retried: false,
    retryOptions: null,
    ack() {
      this.acked = true;
    },
    retry(options) {
      this.retried = true;
      this.retryOptions = options || null;
    }
  };
}

describe("reliable notification delivery", () => {
  it("deduplicates event ingestion and rejects a conflicting replay", async () => {
    const env = makeEnv();
    const first = await createEvent(env);
    const replay = await createEvent(env);

    assert.equal(first.duplicate, false);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.eventId, first.eventId);
    assert.equal(env.dispatchQueue.messages.length, 1);

    await assert.rejects(
      () => createEvent(env, { body: "different" }),
      (error) => error.status === 409
    );
  });

  it("rejects recipient routing fields, provider templates, and unsafe links", async () => {
    const env = makeEnv();
    await assert.rejects(
      () => createEvent(env, { data: { openid: "must-not-pass" } }, "invalid:target"),
      (error) => error.status === 400
    );
    await assert.rejects(
      () => createEvent(env, { data: { template_id: "provider-template" } }, "invalid:template"),
      (error) => error.status === 400
    );
    await assert.rejects(
      () => createEvent(env, { url: "http://insecure.example.com" }, "invalid:url"),
      (error) => error.status === 400
    );
    await assert.rejects(
      () => createEvent(env, { url: "https://user:password@example.com/action" }, "invalid:url-credentials"),
      (error) => error.status === 400
    );
    assert.equal(env.dispatchQueue.messages.length, 0);
  });

  it("creates one logical delivery for duplicate dispatch messages", async () => {
    const env = makeEnv();
    await upsertBinding(env.db, {
      userId: "user-a",
      channel: "wechat_oa",
      externalId: "openid-a"
    });
    const event = await createEvent(env);

    await dispatchEvent(env, event.eventId);
    await dispatchEvent(env, event.eventId);
    const deliveries = await listEventDeliveries(env.db, event.eventId);

    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].status, "pending");
    assert.equal(env.deliveryQueue.messages.length, 2);
  });

  it("defaults production delivery to closed without a user subscription", async () => {
    const env = { ...makeEnv(), SUBSCRIPTIONS_DEFAULT_OPEN: "false" };
    await upsertBinding(env.db, {
      userId: "user-a",
      channel: "wechat_oa",
      externalId: "openid-a"
    });
    const event = await createEvent(env);
    await dispatchEvent(env, event.eventId);

    const status = await getEventStatusForService(env.db, event.eventId, "service-a");
    assert.equal(status.status, "skipped");
    assert.equal(status.skipReason, "not_subscribed");
  });

  it("re-resolves bindings immediately before sending", async () => {
    const env = makeEnv();
    const binding = await upsertBinding(env.db, {
      userId: "user-a",
      channel: "wechat_oa",
      externalId: "openid-a"
    });
    const event = await createEvent(env);
    await dispatchEvent(env, event.eventId);
    const [delivery] = await listEventDeliveries(env.db, event.eventId);
    await revokeBinding(env.db, binding.binding.id, "user-a");

    let called = false;
    await deliverNotification(env, delivery.id, {
      sendWechat: async () => {
        called = true;
        return { ok: true };
      }
    });
    const status = await getEventStatusForService(env.db, event.eventId, "service-a");
    assert.equal(called, false);
    assert.equal(status.status, "skipped");
    assert.equal(status.deliveries[0].errorCode, "not_bound");
  });

  it("re-resolves subscriptions immediately before sending", async () => {
    const env = makeEnv();
    await upsertBinding(env.db, {
      userId: "user-a",
      channel: "wechat_oa",
      externalId: "openid-a"
    });
    const event = await createEvent(env);
    await dispatchEvent(env, event.eventId);
    const [delivery] = await listEventDeliveries(env.db, event.eventId);
    await upsertSubscription(env.db, {
      userId: "user-a",
      serviceId: "service-a",
      eventType: "another.event",
      enabled: true
    });

    const result = await deliverNotification(env, delivery.id, {
      sendWechat: async () => ({ ok: true })
    });
    const [updated] = await listEventDeliveries(env.db, event.eventId);
    assert.equal(result.terminal, true);
    assert.equal(updated.status, "skipped");
    assert.equal(updated.errorCode, "not_subscribed");
  });

  it("honors the current subscription channel list", async () => {
    const env = makeEnv();
    await upsertBinding(env.db, {
      userId: "user-a",
      channel: "wechat_oa",
      externalId: "openid-a"
    });
    await upsertSubscription(env.db, {
      userId: "user-a",
      serviceId: "service-a",
      eventType: "order.approved",
      channels: ["telegram"],
      enabled: true
    });
    const event = await createEvent(env);
    await dispatchEvent(env, event.eventId);

    const status = await getEventStatusForService(env.db, event.eventId, "service-a");
    assert.equal(status.status, "skipped");
    assert.deepEqual(status.deliveries, []);
  });

  it("claims a duplicate delivery only once while an adapter call is in flight", async () => {
    const env = makeEnv();
    await upsertBinding(env.db, {
      userId: "user-a",
      channel: "wechat_oa",
      externalId: "openid-a"
    });
    const event = await createEvent(env);
    await dispatchEvent(env, event.eventId);
    const [delivery] = await listEventDeliveries(env.db, event.eventId);
    let calls = 0;
    let release;
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    const sendWechat = async () => {
      calls += 1;
      await blocked;
      return { ok: true, providerMsgId: "msg-1" };
    };

    const first = deliverNotification(env, delivery.id, { sendWechat });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await deliverNotification(env, delivery.id, { sendWechat });
    release();
    await first;

    assert.equal(calls, 1);
    assert.equal(second.claimed, false);
  });

  it("retries temporary adapter failures per queue message", async () => {
    const env = makeEnv();
    await upsertBinding(env.db, {
      userId: "user-a",
      channel: "wechat_oa",
      externalId: "openid-a"
    });
    const event = await createEvent(env);
    await dispatchEvent(env, event.eventId);
    const [delivery] = await listEventDeliveries(env.db, event.eventId);
    const message = fakeMessage({ deliveryId: delivery.id });

    await processQueueBatch(
      { queue: "cf-notify-delivery", messages: [message] },
      env,
      {
        sendWechat: async () => ({
          ok: false,
          retryable: true,
          errorCode: "provider_rate_limited",
          error: "slow down"
        })
      }
    );
    const [updated] = await listEventDeliveries(env.db, event.eventId);
    assert.equal(message.acked, false);
    assert.equal(message.retried, true);
    assert.ok(message.retryOptions.delaySeconds >= 15);
    assert.equal(updated.status, "retrying");
    assert.equal(updated.attempts, 1);
  });

  it("marks exhausted delivery messages from the DLQ", async () => {
    const env = makeEnv();
    await upsertBinding(env.db, {
      userId: "user-a",
      channel: "wechat_oa",
      externalId: "openid-a"
    });
    const event = await createEvent(env);
    await dispatchEvent(env, event.eventId);
    const [delivery] = await listEventDeliveries(env.db, event.eventId);

    await processDeadLetter(env, { deliveryId: delivery.id }, "delivery");
    const status = await getEventStatusForService(env.db, event.eventId, "service-a");
    assert.equal(status.status, "failed");
    assert.equal(status.deliveries[0].status, "failed");
    assert.equal(status.deliveries[0].errorCode, "delivery_dlq");

    env.deliveryQueue.messages.length = 0;
    const retried = await retryFailedDeliveries(env);
    assert.deepEqual(retried, [{ deliveryId: delivery.id, queued: true }]);
    assert.deepEqual(env.deliveryQueue.messages, [{ deliveryId: delivery.id }]);
  });

  it("restores a retryable delivery when manual re-enqueue fails", async () => {
    const env = makeEnv();
    await upsertBinding(env.db, {
      userId: "user-a",
      channel: "wechat_oa",
      externalId: "openid-a"
    });
    const event = await createEvent(env);
    await dispatchEvent(env, event.eventId);
    const [delivery] = await listEventDeliveries(env.db, event.eventId);
    await processDeadLetter(env, { deliveryId: delivery.id }, "delivery");

    env.deliveryQueue.error = new Error("queue unavailable");
    assert.equal(await retryDelivery(env, delivery.id), false);

    const failed = await getEventStatusForService(env.db, event.eventId, "service-a");
    assert.equal(failed.status, "failed");
    assert.equal(failed.deliveries[0].status, "failed");
    assert.equal(failed.deliveries[0].errorCode, "delivery_dlq");

    env.deliveryQueue.error = null;
    assert.equal(await retryDelivery(env, delivery.id), true);
    const retrying = await getEventStatusForService(env.db, event.eventId, "service-a");
    assert.equal(retrying.status, "dispatching");
    assert.equal(retrying.deliveries[0].status, "pending");
  });

  it("enforces retry risk policy in the delivery core", async () => {
    const permanentEnv = makeEnv();
    await upsertBinding(permanentEnv.db, {
      userId: "user-a",
      channel: "wechat_oa",
      externalId: "openid-a"
    });
    const permanentEvent = await createEvent(permanentEnv);
    await dispatchEvent(permanentEnv, permanentEvent.eventId);
    const [permanentDelivery] = await listEventDeliveries(permanentEnv.db, permanentEvent.eventId);
    await deliverNotification(permanentEnv, permanentDelivery.id, {
      sendWechat: async () => ({
        ok: false,
        retryable: false,
        errorCode: "invalid_user",
        error: "invalid recipient"
      })
    });
    permanentEnv.deliveryQueue.messages.length = 0;
    assert.equal(await retryDelivery(permanentEnv, permanentDelivery.id), false);
    assert.deepEqual(permanentEnv.deliveryQueue.messages, []);

    const unknownEnv = makeEnv();
    await upsertBinding(unknownEnv.db, {
      userId: "user-a",
      channel: "wechat_oa",
      externalId: "openid-a"
    });
    const unknownEvent = await createEvent(unknownEnv, {}, "order:unknown");
    await dispatchEvent(unknownEnv, unknownEvent.eventId);
    const [unknownDelivery] = await listEventDeliveries(unknownEnv.db, unknownEvent.eventId);
    await unknownEnv.db
      .prepare(
        `UPDATE notification_deliveries
         SET status = 'unknown', error_code = 'delivery_dlq' WHERE id = ?`
      )
      .bind(unknownDelivery.id)
      .run();
    unknownEnv.deliveryQueue.messages.length = 0;

    assert.equal(await retryDelivery(unknownEnv, unknownDelivery.id), false);
    assert.equal(await retryDelivery(unknownEnv, unknownDelivery.id, {
      acknowledgeUnknownDuplicateRisk: true
    }), true);
    assert.deepEqual(unknownEnv.deliveryQueue.messages, [{ deliveryId: unknownDelivery.id }]);
  });

  it("does not manually retry a successfully sent delivery", async () => {
    const env = makeEnv();
    await upsertBinding(env.db, {
      userId: "user-a",
      channel: "wechat_oa",
      externalId: "openid-a"
    });
    const event = await createEvent(env);
    await dispatchEvent(env, event.eventId);
    const [delivery] = await listEventDeliveries(env.db, event.eventId);
    await deliverNotification(env, delivery.id, {
      sendWechat: async () => ({ ok: true, providerMsgId: "provider-1" })
    });
    env.deliveryQueue.messages.length = 0;

    assert.equal(await retryDelivery(env, delivery.id), false);
    const [updated] = await listEventDeliveries(env.db, event.eventId);
    assert.equal(updated.status, "sent");
    assert.deepEqual(env.deliveryQueue.messages, []);
  });

  it("shows reliable deliveries in the existing user activity API", async () => {
    const env = makeEnv();
    await upsertBinding(env.db, {
      userId: "user-a",
      channel: "wechat_oa",
      externalId: "openid-a"
    });
    const event = await createEvent(env);
    await dispatchEvent(env, event.eventId);
    const [delivery] = await listEventDeliveries(env.db, event.eventId);
    await deliverNotification(env, delivery.id, {
      sendWechat: async () => ({ ok: true, providerMsgId: "provider-1" })
    });

    const logs = await listLogs(env.db, { userId: "user-a" });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].id, delivery.id);
    assert.equal(logs[0].status, "sent");
  });

  it("retries the same idempotency key and can reconcile when queue send failed", async () => {
    const env = makeEnv();
    env.dispatchQueue.error = new Error("queue unavailable");
    let eventId;
    await assert.rejects(
      () => createEvent(env),
      (error) => {
        eventId = error.details?.eventId;
        return error.status === 503 && error.details?.retryable === true;
      }
    );
    assert.ok(eventId);
    assert.equal(env.dispatchQueue.messages.length, 0);

    env.dispatchQueue.error = null;
    const replay = await createEvent(env);
    assert.equal(replay.eventId, eventId);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.queued, true);
    assert.deepEqual(env.dispatchQueue.messages, [{ eventId }]);

    env.dispatchQueue.messages.length = 0;
    await env.db
      .prepare("UPDATE notification_events SET dispatch_queued_at = NULL, updated_at = ? WHERE id = ?")
      .bind(new Date(0).toISOString(), eventId)
      .run();
    const result = await reconcileQueues(env, { staleSeconds: -1 });
    assert.equal(result.eventsQueued, 1);
    assert.deepEqual(env.dispatchQueue.messages, [{ eventId }]);
  });

  it("does not expose another service's event status", async () => {
    const env = makeEnv();
    const event = await createEvent(env);
    assert.equal(await getEventStatusForService(env.db, event.eventId, "service-b"), null);
  });

  it("uses cf-auth targets without persisting addresses and re-resolves before send", async () => {
    let targetAvailable = true;
    const directoryCalls = [];
    const env = {
      ...makeEnv(),
      NOTIFICATION_DIRECTORY_MODE: "rpc",
      authService: {
        async authorizeNotificationEvent(input) {
          directoryCalls.push({ method: "settings", input });
          return {
            userId: input.userId,
            serviceId: input.serviceId,
            enabled: true,
            eventType: input.eventType,
            channels: [{ channel: "wechat_oa", available: true, enabled: true }]
          };
        },
        async resolveNotificationTargets(input) {
          directoryCalls.push({ method: "targets", input });
          return targetAvailable
            ? {
                decisionVersion: "decision-1",
                targets: [{
                  channel: "wechat_oa",
                  bindingId: "nb_1",
                  address: "sensitive-openid",
                  maskedTarget: "wx***openid"
                }]
              }
            : { decisionVersion: "decision-2", targets: [], skipReason: "not_bound" };
        }
      }
    };

    const event = await createEvent(env);
    await dispatchEvent(env, event.eventId);
    const [delivery] = await listEventDeliveries(env.db, event.eventId);
    assert.equal(delivery.bindingId, "nb_1");
    assert.equal(delivery.targetKey, "nb_1");

    const stored = await env.db
      .prepare("SELECT * FROM notification_deliveries WHERE id = ?")
      .bind(delivery.id)
      .first();
    assert.doesNotMatch(JSON.stringify(stored), /sensitive-openid/);

    targetAvailable = false;
    let adapterCalled = false;
    await deliverNotification(env, delivery.id, {
      sendWechat: async () => {
        adapterCalled = true;
        return { ok: true };
      }
    });

    const [updated] = await listEventDeliveries(env.db, event.eventId);
    assert.equal(adapterCalled, false);
    assert.equal(updated.status, "skipped");
    assert.equal(updated.errorCode, "not_bound");
    assert.equal(directoryCalls.filter((call) => call.method === "settings").length, 1);
    assert.equal(directoryCalls.filter((call) => call.method === "targets").length, 2);
  });

  it("delays WeChat delivery until cf-auth quiet hours end", async () => {
    const deferUntil = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const env = {
      ...makeEnv(),
      NOTIFICATION_DIRECTORY_MODE: "rpc",
      authService: {
        async authorizeNotificationEvent(input) {
          return {
            ...input,
            enabled: true,
            channels: [{ channel: "wechat_oa", available: true, enabled: true }]
          };
        },
        async resolveNotificationTargets() {
          return {
            decisionVersion: "quiet-policy",
            deferUntil,
            targets: [{
              channel: "wechat_oa",
              bindingId: "nb_quiet",
              address: "quiet-openid"
            }]
          };
        }
      }
    };
    const event = await createEvent(env, {}, "quiet:event");
    await dispatchEvent(env, event.eventId);
    const [delivery] = await listEventDeliveries(env.db, event.eventId);
    assert.equal(delivery.nextAttemptAt, deferUntil);
    assert.ok(env.deliveryQueue.options[0].delaySeconds > 0);

    let adapterCalled = false;
    const result = await deliverNotification(env, delivery.id, {
      sendWechat: async () => {
        adapterCalled = true;
        return { ok: true };
      }
    });
    assert.equal(adapterCalled, false);
    assert.equal(result.retry, true);
    assert.ok(result.delaySeconds > 0);
  });

  it("returns an accepted idempotent replay without re-authorizing the recipient", async () => {
    let settingsCalls = 0;
    const env = {
      ...makeEnv(),
      NOTIFICATION_DIRECTORY_MODE: "rpc",
      authService: {
        async authorizeNotificationEvent(input) {
          settingsCalls += 1;
          if (settingsCalls > 1) return null;
          return {
            ...input,
            enabled: true,
            channels: [{ channel: "wechat_oa", available: true, enabled: true }]
          };
        }
      }
    };

    const first = await createEvent(env);
    const replay = await createEvent(env);

    assert.equal(replay.eventId, first.eventId);
    assert.equal(replay.duplicate, true);
    assert.equal(settingsCalls, 1);
  });

  it("rejects raw HTML and provider-controlled fields", async () => {
    const env = makeEnv();
    await assert.rejects(
      () => createEvent(env, { html: "<b>unsafe</b>" }, "invalid:html"),
      (error) => error.status === 400
    );
    await assert.rejects(
      () => createEvent(env, { providerTemplateId: "provider-1" }, "invalid:provider-template"),
      (error) => error.status === 400
    );
    await assert.rejects(
      () => createEvent(env, { data: { raw_html: "<b>unsafe</b>" } }, "invalid:data-html"),
      (error) => error.status === 400
    );
    await assert.rejects(
      () => createEvent(env, { openId: "must-not-pass" }, "invalid:camel-target"),
      (error) => error.status === 400
    );
  });

  it("does not persist a target repeated by an adapter error", async () => {
    const env = {
      ...makeEnv(),
      NOTIFICATION_DIRECTORY_MODE: "rpc",
      authService: {
        async authorizeNotificationEvent(input) {
          return { ...input, enabled: true, channels: [] };
        },
        async resolveNotificationTargets() {
          return {
            targets: [{
              channel: "wechat_oa",
              bindingId: "nb_private",
              address: "private-openid-value"
            }]
          };
        }
      }
    };
    const event = await createEvent(env);
    await dispatchEvent(env, event.eventId);
    const [delivery] = await listEventDeliveries(env.db, event.eventId);

    await deliverNotification(env, delivery.id, {
      sendWechat: async () => ({
        ok: false,
        retryable: false,
        errorCode: "provider_rejected",
        error: "provider rejected private-openid-value"
      })
    });

    const stored = await env.db
      .prepare("SELECT error_detail AS errorDetail FROM notification_deliveries WHERE id = ?")
      .bind(delivery.id)
      .first();
    assert.doesNotMatch(stored.errorDetail, /private-openid-value/);
    assert.match(stored.errorDetail, /redacted-target/);
  });

  it("does not let an rpc-mode caller override policy channels", async () => {
    const env = {
      ...makeEnv(),
      NOTIFICATION_DIRECTORY_MODE: "rpc",
      authService: {
        async authorizeNotificationEvent(input) {
          return { ...input, enabled: true, channels: [] };
        }
      }
    };
    await assert.rejects(
      () => createEvent(env, { channels: ["wechat_oa"] }, "invalid:channels"),
      (error) => error.status === 400
    );
  });

  it("delivers a WeCom target resolved by cf-auth without persisting its user ID", async () => {
    const env = {
      ...makeEnv(),
      NOTIFICATION_DIRECTORY_MODE: "rpc",
      authService: {
        async authorizeNotificationEvent(input) {
          return {
            ...input,
            enabled: true,
            channels: [{ channel: "wecom", available: true, enabled: true }]
          };
        },
        async resolveNotificationTargets() {
          return {
            decisionVersion: "wecom-policy-1",
            targets: [{
              channel: "wecom",
              bindingId: "nb_wecom_private",
              address: "sensitive-wecom-user-id"
            }]
          };
        }
      }
    };
    const event = await createEvent(env, {}, "wecom:event");
    await dispatchEvent(env, event.eventId);
    const [delivery] = await listEventDeliveries(env.db, event.eventId);
    let target;
    await deliverNotification(env, delivery.id, {
      async sendWecom(_runtime, input) {
        target = input.userId;
        return { ok: true, providerMsgId: "wecom-provider-1" };
      }
    });

    assert.equal(target, "sensitive-wecom-user-id");
    const storedEvent = await env.db
      .prepare("SELECT * FROM notification_events WHERE id = ?")
      .bind(event.eventId)
      .first();
    const storedDelivery = await env.db
      .prepare("SELECT * FROM notification_deliveries WHERE id = ?")
      .bind(delivery.id)
      .first();
    assert.doesNotMatch(JSON.stringify({ storedEvent, storedDelivery }), /sensitive-wecom-user-id/);
    assert.equal(storedDelivery.status, "sent");
  });
});
