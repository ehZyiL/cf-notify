import { verifyJwtHs256 } from "./crypto.mjs";
import { bearerToken, HttpError } from "./http.mjs";

/**
 * Verify user JWT issued by cf-auth (HS256, same secret).
 * @returns {{ id: string, email: string|null }}
 */
export async function requireUser(env, request) {
  const token = bearerToken(request);
  if (!token) throw new HttpError(401, "authentication required");
  if (!env.CF_AUTH_JWT_SECRET) throw new HttpError(500, "CF_AUTH_JWT_SECRET is not configured");

  let payload;
  try {
    payload = await verifyJwtHs256(token, env.CF_AUTH_JWT_SECRET, {
      audience: env.CF_AUTH_JWT_AUDIENCE || undefined
    });
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
