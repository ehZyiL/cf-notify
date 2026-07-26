import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requireUser } from "../src/auth-user.mjs";
import { base64UrlEncode } from "../src/crypto.mjs";
import { createMemoryKv } from "../src/memory-kv.mjs";

const encoder = new TextEncoder();

async function signRs256(privateKey, kid, claims) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT", kid })));
  const payload = base64UrlEncode(
    encoder.encode(JSON.stringify({ iat: now, exp: now + 300, ...claims }))
  );
  const body = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, encoder.encode(body));
  return `${body}.${base64UrlEncode(signature)}`;
}

describe("cf-auth user JWT verification", () => {
  it("verifies RS256 tokens through the CF_AUTH service binding and caches JWKS", async () => {
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256"
      },
      true,
      ["sign", "verify"]
    );
    const kid = "test-key-1";
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const token = await signRs256(pair.privateKey, kid, {
      sub: "user-rs256",
      email: "user@example.com",
      iss: "https://auth.example.com",
      aud: "cf-notify"
    });
    let fetches = 0;
    const env = {
      kv: createMemoryKv(),
      CF_AUTH_ISSUER: "https://auth.example.com",
      CF_AUTH_JWT_AUDIENCE: "cf-notify",
      authService: {
        async fetch() {
          fetches += 1;
          return Response.json({ keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] });
        }
      }
    };
    const request = new Request("https://notify.example/api/bindings", {
      headers: { Authorization: `Bearer ${token}` }
    });

    const first = await requireUser(env, request);
    const second = await requireUser(env, request);
    assert.equal(first.id, "user-rs256");
    assert.equal(second.email, "user@example.com");
    assert.equal(fetches, 1);
  });

  it("rejects a token with the wrong issuer", async () => {
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256"
      },
      true,
      ["sign", "verify"]
    );
    const kid = "test-key-2";
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const token = await signRs256(pair.privateKey, kid, {
      sub: "user-rs256",
      iss: "https://wrong.example.com"
    });
    const env = {
      kv: createMemoryKv(),
      CF_AUTH_ISSUER: "https://auth.example.com",
      authService: { fetch: async () => Response.json({ keys: [{ ...jwk, kid, alg: "RS256" }] }) }
    };
    const request = new Request("https://notify.example/api/bindings", {
      headers: { Authorization: `Bearer ${token}` }
    });

    await assert.rejects(() => requireUser(env, request), (error) => error.status === 401);
  });

  it("stops reading an oversized chunked JWKS response", async () => {
    const header = base64UrlEncode(
      encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "oversized" }))
    );
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("x".repeat(40 * 1024)));
        controller.enqueue(encoder.encode("x".repeat(40 * 1024)));
      },
      cancel() {
        cancelled = true;
      }
    });
    const env = {
      kv: createMemoryKv(),
      authService: { fetch: async () => new Response(body) }
    };
    const request = new Request("https://notify.example/api/bindings", {
      headers: { Authorization: `Bearer ${header}.e30.AA` }
    });

    await assert.rejects(
      () => requireUser(env, request),
      (error) => error.status === 401 && error.message === "JWKS response is too large"
    );
    assert.equal(cancelled, true);
  });
});
