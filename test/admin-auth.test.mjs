import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_STATE_COOKIE,
  endAdminSession,
  finishAdminLogin,
  getAdminSession,
  requireAdminSession,
  startAdminLogin
} from "../src/admin-auth.mjs";
import { createMemoryKv } from "../src/memory-kv.mjs";

const ISSUER = "https://auth.example.com";
const CLIENT_ID = "cf-notify-admin";

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function idToken(nonce) {
  const now = Math.floor(Date.now() / 1000);
  return [
    base64UrlJson({ alg: "RS256", typ: "JWT" }),
    base64UrlJson({
      iss: ISSUER,
      sub: "admin-1",
      aud: CLIENT_ID,
      iat: now,
      exp: now + 900,
      nonce
    }),
    "test-signature"
  ].join(".");
}

function cookiePair(response, name) {
  const values = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("Set-Cookie") || ""];
  const cookie = values.find((value) => value.startsWith(`${name}=`));
  return cookie ? cookie.split(";", 1)[0] : "";
}

function makeEnv({ admin = true, accessToken = "admin-access-token" } = {}) {
  const kv = createMemoryKv();
  let expectedNonce = "";
  const env = {
    kv,
    CF_AUTH_ISSUER: ISSUER,
    ADMIN_OAUTH_CLIENT_ID: CLIENT_ID,
    authService: {
      async verifyAdminAccessToken(input) {
        assert.equal(input.clientId, CLIENT_ID);
        assert.equal(input.accessToken, accessToken);
        return admin
          ? {
              valid: true,
              userId: "admin-1",
              email: "admin@example.com",
              displayName: "Admin",
              platformRole: "admin",
              serviceId: "cf-notify",
              serviceRole: "admin"
            }
          : { valid: false, reason: "not_admin" };
      }
    },
    async oauthFetch(input, init = {}) {
      const url = new URL(typeof input === "string" ? input : input.url || input.toString());
      if (url.pathname.includes(".well-known")) {
        return Response.json({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/oauth2/authorize`,
          token_endpoint: `${ISSUER}/oauth2/token`,
          jwks_uri: `${ISSUER}/.well-known/jwks.json`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"]
        });
      }
      if (url.pathname === "/oauth2/token") {
        const body = new URLSearchParams(init.body);
        assert.equal(body.get("grant_type"), "authorization_code");
        assert.equal(body.get("client_id"), CLIENT_ID);
        assert.match(body.get("code_verifier"), /^[A-Za-z0-9._~-]{43,128}$/);
        return Response.json({
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: 900,
          id_token: idToken(expectedNonce)
        }, { headers: { "Cache-Control": "no-store" } });
      }
      throw new Error(`unexpected OAuth request: ${url}`);
    }
  };
  return {
    env,
    setExpectedNonce(value) {
      expectedNonce = value;
    }
  };
}

async function completeLogin(fixture) {
  const login = await startAdminLogin(
    new Request("https://notify.example.com/api/admin/auth/login?returnTo=%2Fadmin"),
    fixture.env
  );
  assert.equal(login.status, 302);
  const authorizationUrl = new URL(login.headers.get("Location"));
  assert.equal(authorizationUrl.origin, ISSUER);
  assert.equal(authorizationUrl.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  assert.match(authorizationUrl.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
  fixture.setExpectedNonce(authorizationUrl.searchParams.get("nonce"));
  const state = authorizationUrl.searchParams.get("state");
  const stateCookie = cookiePair(login, ADMIN_STATE_COOKIE);
  assert.equal(stateCookie, `${ADMIN_STATE_COOKIE}=${state}`);

  const callback = await finishAdminLogin(
    new Request(
      `https://notify.example.com/api/admin/auth/callback?code=code-1&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: stateCookie } }
    ),
    fixture.env
  );
  return { login, callback, sessionCookie: cookiePair(callback, ADMIN_SESSION_COOKIE) };
}

describe("cf-notify admin SSO", () => {
  it("creates a PKCE transaction and an opaque HttpOnly admin session", async () => {
    const fixture = makeEnv();
    const { callback, sessionCookie } = await completeLogin(fixture);
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("Location"), "/admin");
    assert.match(sessionCookie, /^__Host-cf_notify_admin_session=/);
    assert.doesNotMatch(sessionCookie, /admin-access-token/);
    assert.match(callback.headers.get("Set-Cookie"), /HttpOnly/);

    const session = await getAdminSession(
      new Request("https://notify.example.com/api/admin/session", {
        headers: { Cookie: sessionCookie }
      }),
      fixture.env
    );
    assert.equal(session.authenticated, true);
    assert.equal(session.user.email, "admin@example.com");
    assert.equal(session.platformRole, "admin");
  });

  it("rejects state mismatch before exchanging a code", async () => {
    const fixture = makeEnv();
    const login = await startAdminLogin(
      new Request("https://notify.example.com/api/admin/auth/login"),
      fixture.env
    );
    const stateCookie = cookiePair(login, ADMIN_STATE_COOKIE);
    await assert.rejects(
      finishAdminLogin(
        new Request("https://notify.example.com/api/admin/auth/callback?code=x&state=wrong", {
          headers: { Cookie: stateCookie }
        }),
        fixture.env
      ),
      (error) => error.status === 400 && /state/.test(error.message)
    );
  });

  it("denies a valid OAuth user who is not a platform administrator", async () => {
    const fixture = makeEnv({ admin: false });
    await assert.rejects(
      completeLogin(fixture),
      (error) => error.status === 403 && /administrator/.test(error.message)
    );
  });

  it("expires KV sessions", async () => {
    const fixture = makeEnv();
    const { sessionCookie } = await completeLogin(fixture);
    fixture.env.kv._setNow(Date.now() + 901_000);
    await assert.rejects(
      requireAdminSession(
        fixture.env,
        new Request("https://notify.example.com/api/admin/session", {
          headers: { Cookie: sessionCookie }
        })
      ),
      (error) => error.status === 401 && /expired/.test(error.message)
    );
  });

  it("requires same-origin protection for logout and deletes the session", async () => {
    const fixture = makeEnv();
    const { sessionCookie } = await completeLogin(fixture);
    const request = new Request("https://notify.example.com/api/admin/session", {
      method: "DELETE",
      headers: { Cookie: sessionCookie }
    });
    await assert.rejects(
      endAdminSession(request, fixture.env),
      (error) => error.status === 403
    );

    const logout = await endAdminSession(
      new Request("https://notify.example.com/api/admin/session", {
        method: "DELETE",
        headers: { Cookie: sessionCookie, "X-CSRF-Protection": "same-origin" }
      }),
      fixture.env
    );
    assert.equal(logout.status, 204);
    await assert.rejects(
      requireAdminSession(
        fixture.env,
        new Request("https://notify.example.com/api/admin/session", {
          headers: { Cookie: sessionCookie }
        })
      ),
      (error) => error.status === 401
    );
  });
});
