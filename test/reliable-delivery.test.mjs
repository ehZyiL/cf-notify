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
    this.error = null;
  }

  async send(body) {
    if (this.error) throw this.error;
    this.messages.push(body);
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
});
