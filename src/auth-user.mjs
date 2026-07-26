import { decodeJwtHeader, verifyJwtHs256, verifyJwtRs256 } from "./crypto.mjs";
import { bearerToken, HttpError } from "./http.mjs";

const JWKS_CACHE_KEY = "cf-auth:jwks:v1";
const MAX_JWKS_BYTES = 64 * 1024;

async function readSmallResponse(response) {
  const declared = Number(response.headers.get("Content-Length") || 0);
  if (declared > MAX_JWKS_BYTES) throw new Error("JWKS response is too large");
  if (!response.body) return JSON.parse("");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_JWKS_BYTES) {
      await reader.cancel();
      throw new Error("JWKS response is too large");
    }
    text += decoder.decode(value, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}

async function fetchJwks(env) {
  let response;
  if (env.authService?.fetch) {
    response = await env.authService.fetch(
      new Request("https://cf-auth.internal/.well-known/jwks.json", {
        headers: { Accept: "application/json" }
      })
    );
  } else if (env.CF_AUTH_JWKS_URL) {
    response = await fetch(env.CF_AUTH_JWKS_URL, { headers: { Accept: "application/json" } });
  } else {
    throw new Error("CF_AUTH service binding or JWKS URL is not configured");
  }
  if (!response.ok) throw new Error(`cf-auth JWKS request failed with HTTP ${response.status}`);
  const jwks = await readSmallResponse(response);
  if (!Array.isArray(jwks?.keys)) throw new Error("cf-auth returned an invalid JWKS");
  await env.kv?.put(JWKS_CACHE_KEY, JSON.stringify(jwks), { expirationTtl: 300 });
  return jwks;
}

async function loadJwks(env, kid) {
  const cachedRaw = await env.kv?.get(JWKS_CACHE_KEY);
  if (cachedRaw) {
    try {
      const cached = JSON.parse(cachedRaw);
      if (Array.isArray(cached?.keys) && cached.keys.some((key) => key?.kid === kid)) return cached;
    } catch {
      // Refresh malformed or stale cache entries below.
    }
  }
  return fetchJwks(env);
}

async function verifyUserToken(env, token) {
  const header = decodeJwtHeader(token);
  const options = {
    audience: env.CF_AUTH_JWT_AUDIENCE || undefined,
    issuer: env.CF_AUTH_ISSUER || undefined
  };
  if (header.alg === "RS256") {
    const jwks = await loadJwks(env, header.kid);
    return verifyJwtRs256(token, jwks, options);
  }
  if (header.alg === "HS256") {
    if (!env.CF_AUTH_JWT_SECRET) throw new Error("HS256 verification is not configured");
    return verifyJwtHs256(token, env.CF_AUTH_JWT_SECRET, options);
  }
  throw new Error("invalid token algorithm");
}

/**
 * Verify a user JWT issued by cf-auth (RS256/JWKS, with HS256 for local compatibility).
 * @returns {{ id: string, email: string|null }}
 */
export async function requireUser(env, request) {
  const token = bearerToken(request);
  if (!token) throw new HttpError(401, "authentication required");
  let payload;
  try {
    payload = await verifyUserToken(env, token);
  } catch (e) {
    throw new HttpError(401, e.message || "invalid token");
  }
  if (!payload.sub) throw new HttpError(401, "invalid token subject");
  return {
    id: String(payload.sub),
    email: payload.email || null,
    platformRole: payload.platformRole || null,
    services: Array.isArray(payload.services) ? payload.services : []
  };
}
