import * as oauth from "oauth4webapi";
import { timingSafeSecretEqual } from "./crypto.mjs";
import { HttpError } from "./http.mjs";

const TRANSACTION_PREFIX = "admin:oauth:transaction:";
const SESSION_PREFIX = "admin:session:";
const TRANSACTION_TTL_SECONDS = 600;
const MAX_SESSION_TTL_SECONDS = 15 * 60;
const MAX_OAUTH_RESPONSE_BYTES = 64 * 1024;

export const ADMIN_SESSION_COOKIE = "__Host-cf_notify_admin_session";
export const ADMIN_STATE_COOKIE = "__Host-cf_notify_admin_oauth_state";

function serializeCookie(name, value, maxAge) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${Math.max(0, Math.floor(Number(maxAge) || 0))}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax"
  ].join("; ");
}

function cookieValue(request, name) {
  for (const part of String(request.headers.get("Cookie") || "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1 || part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

function issuer(env) {
  const value = String(env.CF_AUTH_ISSUER || "").replace(/\/$/, "");
  if (!value || new URL(value).protocol !== "https:") {
    throw new HttpError(503, "admin SSO issuer is not configured");
  }
  return value;
}

function client(env) {
  const clientId = String(env.ADMIN_OAUTH_CLIENT_ID || "").trim();
  if (!clientId) throw new HttpError(503, "admin SSO client is not configured");
  return { client_id: clientId };
}

function callbackUrl(request) {
  return new URL("/api/admin/auth/callback", new URL(request.url).origin).toString();
}

function oauthOptions(env) {
  const options = { signal: AbortSignal.timeout(10_000) };
  if (typeof env.oauthFetch === "function") options[oauth.customFetch] = env.oauthFetch;
  return options;
}

async function boundedResponse(response) {
  const declared = response.headers.get("Content-Length");
  if (declared && Number(declared) > MAX_OAUTH_RESPONSE_BYTES) {
    throw new HttpError(502, "OAuth server response is too large");
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      length += chunk.byteLength;
      if (length > MAX_OAUTH_RESPONSE_BYTES) {
        await reader.cancel("OAuth server response is too large").catch(() => {});
        throw new HttpError(502, "OAuth server response is too large");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, response);
}

async function discover(env) {
  const expectedIssuer = new URL(issuer(env));
  const response = await boundedResponse(
    await oauth.discoveryRequest(expectedIssuer, oauthOptions(env))
  );
  const metadata = await oauth.processDiscoveryResponse(expectedIssuer, response);
  for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
    const endpoint = metadata[key];
    if (typeof endpoint !== "string" || new URL(endpoint).protocol !== "https:") {
      throw new HttpError(502, `OAuth discovery has no secure ${key}`);
    }
  }
  if (
    Array.isArray(metadata.code_challenge_methods_supported)
    && !metadata.code_challenge_methods_supported.includes("S256")
  ) {
    throw new HttpError(502, "OAuth server does not support PKCE S256");
  }
  return metadata;
}

function safeReturnTo(request) {
  const requested = new URL(request.url).searchParams.get("returnTo") || "/admin";
  try {
    const url = new URL(requested, new URL(request.url).origin);
    if (url.origin === new URL(request.url).origin && url.pathname.startsWith("/admin")) {
      return `${url.pathname}${url.search}${url.hash}`;
    }
  } catch {
    // Fall through to the fixed admin route.
  }
  return "/admin";
}

function noStoreRedirect(location, cookies = []) {
  const headers = new Headers({
    Location: location,
    "Cache-Control": "no-store",
    Pragma: "no-cache"
  });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function assertSameOriginWrite(request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const origin = request.headers.get("Origin");
  const sameOriginHeader =
    !origin && request.headers.get("X-CSRF-Protection") === "same-origin";
  if ((!origin && !sameOriginHeader) || (origin && origin !== new URL(request.url).origin)) {
    throw new HttpError(403, "cross-origin admin session request denied");
  }
}

async function verifyAdmin(env, accessToken) {
  if (!env.authService || typeof env.authService.verifyAdminAccessToken !== "function") {
    throw new HttpError(503, "cf-auth admin verification is unavailable");
  }
  const result = await env.authService.verifyAdminAccessToken({
    clientId: client(env).client_id,
    accessToken
  });
  if (!result?.valid || result.platformRole !== "admin") {
    throw new HttpError(403, "platform administrator access is required");
  }
  return result;
}

export async function startAdminLogin(request, env) {
  const metadata = await discover(env);
  const state = oauth.generateRandomState();
  const nonce = oauth.generateRandomNonce();
  const codeVerifier = oauth.generateRandomCodeVerifier();
  const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);
  const redirectUri = callbackUrl(request);
  const authorizationUrl = new URL(metadata.authorization_endpoint);
  authorizationUrl.searchParams.set("client_id", client(env).client_id);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("scope", "openid profile email");
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("nonce", nonce);
  authorizationUrl.searchParams.set("code_challenge", codeChallenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");

  await env.kv.put(
    `${TRANSACTION_PREFIX}${state}`,
    JSON.stringify({
      issuer: metadata.issuer,
      clientId: client(env).client_id,
      redirectUri,
      returnTo: safeReturnTo(request),
      nonce,
      codeVerifier,
      createdAt: Date.now()
    }),
    { expirationTtl: TRANSACTION_TTL_SECONDS }
  );
  return noStoreRedirect(authorizationUrl.toString(), [
    serializeCookie(ADMIN_STATE_COOKIE, state, TRANSACTION_TTL_SECONDS)
  ]);
}

export async function finishAdminLogin(request, env) {
  const callback = new URL(request.url);
  const state = callback.searchParams.get("state") || "";
  const cookieState = cookieValue(request, ADMIN_STATE_COOKIE);
  if (!state || !cookieState || !(await timingSafeSecretEqual(state, cookieState))) {
    throw new HttpError(400, "admin OAuth state is invalid");
  }
  const transactionKey = `${TRANSACTION_PREFIX}${state}`;
  const raw = await env.kv.get(transactionKey);
  if (!raw) throw new HttpError(400, "admin OAuth transaction expired");
  await env.kv.delete(transactionKey);

  let transaction;
  try {
    transaction = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "admin OAuth transaction is invalid");
  }
  const metadata = await discover(env);
  if (
    transaction.issuer !== metadata.issuer
    || transaction.clientId !== client(env).client_id
    || transaction.redirectUri !== callbackUrl(request)
  ) {
    throw new HttpError(400, "admin OAuth configuration changed during login");
  }

  let parameters;
  let tokens;
  try {
    parameters = oauth.validateAuthResponse(metadata, client(env), callback.searchParams, state);
    const tokenResponse = await boundedResponse(await oauth.authorizationCodeGrantRequest(
      metadata,
      client(env),
      oauth.None(),
      parameters,
      transaction.redirectUri,
      transaction.codeVerifier,
      oauthOptions(env)
    ));
    tokens = await oauth.processAuthorizationCodeResponse(metadata, client(env), tokenResponse, {
      expectedNonce: transaction.nonce,
      requireIdToken: true
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "admin OAuth response is invalid");
  }

  const admin = await verifyAdmin(env, tokens.access_token);
  const ttl = Math.max(
    60,
    Math.min(MAX_SESSION_TTL_SECONDS, Number(tokens.expires_in) || MAX_SESSION_TTL_SECONDS)
  );
  const sessionId = oauth.generateRandomState();
  await env.kv.put(
    `${SESSION_PREFIX}${sessionId}`,
    JSON.stringify({
      accessToken: tokens.access_token,
      expiresAt: Date.now() + ttl * 1000,
      user: {
        id: admin.userId,
        email: admin.email || null,
        displayName: admin.displayName || null
      },
      createdAt: Date.now()
    }),
    { expirationTtl: ttl }
  );
  return noStoreRedirect(transaction.returnTo || "/admin", [
    serializeCookie(ADMIN_STATE_COOKIE, "", 0),
    serializeCookie(ADMIN_SESSION_COOKIE, sessionId, ttl)
  ]);
}

export async function requireAdminSession(env, request) {
  assertSameOriginWrite(request);
  const sessionId = cookieValue(request, ADMIN_SESSION_COOKIE);
  if (!sessionId) throw new HttpError(401, "admin SSO session is required");
  const raw = await env.kv.get(`${SESSION_PREFIX}${sessionId}`);
  if (!raw) throw new HttpError(401, "admin SSO session expired");
  let session;
  try {
    session = JSON.parse(raw);
  } catch {
    await env.kv.delete(`${SESSION_PREFIX}${sessionId}`);
    throw new HttpError(401, "admin SSO session is invalid");
  }
  if (!session.accessToken || Number(session.expiresAt) <= Date.now()) {
    await env.kv.delete(`${SESSION_PREFIX}${sessionId}`);
    throw new HttpError(401, "admin SSO session expired");
  }
  const admin = await verifyAdmin(env, session.accessToken);
  return { sessionId, session, admin };
}

export async function getAdminSession(request, env) {
  const { session, admin } = await requireAdminSession(env, request);
  return {
    authenticated: true,
    user: session.user,
    expiresAt: session.expiresAt,
    platformRole: admin.platformRole
  };
}

export async function endAdminSession(request, env) {
  assertSameOriginWrite(request);
  const sessionId = cookieValue(request, ADMIN_SESSION_COOKIE);
  if (sessionId) await env.kv.delete(`${SESSION_PREFIX}${sessionId}`);
  return new Response(null, {
    status: 204,
    headers: {
      "Set-Cookie": serializeCookie(ADMIN_SESSION_COOKIE, "", 0),
      "Cache-Control": "no-store",
      Pragma: "no-cache"
    }
  });
}

export function clearAdminSessionCookie() {
  return serializeCookie(ADMIN_SESSION_COOKIE, "", 0);
}
