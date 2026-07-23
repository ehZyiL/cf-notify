import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryDb } from "../src/sqlite-d1.mjs";
import { createNotifyClient, requireServiceClient } from "../src/auth-service.mjs";
import { HttpError } from "../src/http.mjs";

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
});
