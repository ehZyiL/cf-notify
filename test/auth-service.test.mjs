import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryDb } from "../src/sqlite-d1.mjs";
import {
  createNotifyClient,
  requireServiceClient,
  revokeNotifyClient
} from "../src/auth-service.mjs";
import { HttpError } from "../src/http.mjs";
import { hashSecret } from "../src/crypto.mjs";

describe("S1 service client auth", () => {
  it("creates client and authenticates with clientId:secret bearer", async () => {
    const db = createMemoryDb();
    const created = await createNotifyClient(db, {
      serviceId: "xy-erp",
      name: "XY ERP",
      clientSecret: "test-client-secret-value"
    });
    assert.ok(created.clientId);
    assert.equal(created.clientSecret, "test-client-secret-value");
    const stored = await db
      .prepare("SELECT secret_hash AS secretHash FROM notify_clients WHERE client_id = ?")
      .bind(created.clientId)
      .first();
    assert.match(stored.secretHash, /^sha256\.v1\./);

    const req = new Request("https://notify.example.com/api/v1/send", {
      headers: {
        Authorization: `Bearer ${created.clientId}:test-client-secret-value`
      }
    });
    const client = await requireServiceClient(db, req);
    assert.equal(client.serviceId, "xy-erp");
  });

  it("rejects wrong secret", async () => {
    const db = createMemoryDb();
    const created = await createNotifyClient(db, {
      serviceId: "xy-erp",
      clientSecret: "correct-secret"
    });
    const req = new Request("https://n.example/api/v1/send", {
      headers: { Authorization: `Bearer ${created.clientId}:wrong-secret` }
    });
    await assert.rejects(() => requireServiceClient(db, req), (e) => {
      assert.ok(e instanceof HttpError);
      assert.equal(e.status, 401);
      return true;
    });
  });

  it("enforces client scopes and revocation", async () => {
    const db = createMemoryDb();
    const created = await createNotifyClient(db, {
      serviceId: "xy-erp",
      clientSecret: "scoped-secret",
      scopes: ["notifications.delivery.read"]
    });
    const request = new Request("https://n.example/api/v1/notifications/event", {
      headers: { Authorization: `Bearer ${created.clientId}:scoped-secret` }
    });
    const reader = await requireServiceClient(db, request, {
      scope: "notifications.delivery.read"
    });
    assert.deepEqual(reader.scopes, ["notifications.delivery.read"]);
    await assert.rejects(
      () => requireServiceClient(db, request, { scope: "notifications.send" }),
      (error) => error.status === 403
    );

    assert.equal(await revokeNotifyClient(db, created.clientId), true);
    await assert.rejects(() => requireServiceClient(db, request), (error) => error.status === 401);
  });

  it("continues to accept pre-migration PBKDF2 client hashes", async () => {
    const db = createMemoryDb();
    const created = await createNotifyClient(db, {
      serviceId: "legacy",
      clientSecret: "legacy-secret"
    });
    await db
      .prepare("UPDATE notify_clients SET secret_hash = ? WHERE client_id = ?")
      .bind(await hashSecret("legacy-secret"), created.clientId)
      .run();
    const request = new Request("https://n.example/api/v1/send", {
      headers: { Authorization: `Bearer ${created.clientId}:legacy-secret` }
    });
    const authenticated = await requireServiceClient(db, request);
    assert.equal(authenticated.serviceId, "legacy");
  });
});
