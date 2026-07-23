import { requireServiceClient, createNotifyClient, listNotifyClients } from "./auth-service.mjs";
import { requireUser } from "./auth-user.mjs";
import {
  createBindCode,
  getBindCodeStatus,
  listBindingsForUser,
  revokeBinding
} from "./bindings.mjs";
import {
  handleWechatMessage,
  verifyWechatSignature
} from "./channels/wechat-callback.mjs";
import { bearerToken, HttpError, json, readJson, requireFields, routeParts } from "./http.mjs";
import { assertBindCodeAllowed } from "./rate-limit.mjs";
import { listLogs, retryFailedLogs, sendNotification } from "./send.mjs";
import {
  deleteSubscription,
  listSubscriptions,
  upsertSubscription
} from "./subscriptions.mjs";
import { upsertChannelApp } from "./templates.mjs";
import { signJwtHs256 } from "./crypto.mjs";

/**
 * @param {object} env
 */
export function createAppHandler(env) {
  return async function handle(request) {
    try {
      const url = new URL(request.url);
      if (request.method === "OPTIONS") return new Response(null, { status: 204 });

      const parts = routeParts(url);

      if (
        (parts[0] === "health" || parts[0] === "healthz" || (parts[0] === "api" && parts[1] === "health")) &&
        request.method === "GET"
      ) {
        return json({ ok: true, service: "cf-notify", time: new Date().toISOString() });
      }

      if (parts[0] === "wechat" && parts[1] === "callback") {
        return await handleWechatCallback(request, env, url);
      }

      if (parts[0] === "api") {
        return await handleApi(request, env, parts.slice(1), url);
      }

      throw new HttpError(404, "not found");
    } catch (error) {
      if (error instanceof HttpError) {
        const headers = {};
        if (error.status === 429 && error.details?.retryAfterSec) {
          headers["Retry-After"] = String(error.details.retryAfterSec);
        }
        return json(
          { ok: false, error: error.message, details: error.details },
          { status: error.status, headers }
        );
      }
      console.error(error && error.stack ? error.stack : error);
      return json(
        { ok: false, error: error && error.message ? error.message : String(error) },
        { status: 500 }
      );
    }
  };
}

async function handleWechatCallback(request, env, url) {
  const token = env.WECHAT_TOKEN || "";
  if (request.method === "GET") {
    const signature = url.searchParams.get("signature") || "";
    const timestamp = url.searchParams.get("timestamp") || "";
    const nonce = url.searchParams.get("nonce") || "";
    const echostr = url.searchParams.get("echostr") || "";
    const ok = await verifyWechatSignature(token, { signature, timestamp, nonce });
    if (!ok) return new Response("invalid signature", { status: 403 });
    return new Response(echostr, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  if (request.method === "POST") {
    if (token) {
      const signature = url.searchParams.get("signature") || url.searchParams.get("msg_signature") || "";
      const timestamp = url.searchParams.get("timestamp") || "";
      const nonce = url.searchParams.get("nonce") || "";
      // plaintext signature; secure mode uses msg_signature (token+timestamp+nonce+encrypt) — P1.5 partial
      if (url.searchParams.get("encrypt_type") !== "aes") {
        const ok = await verifyWechatSignature(token, { signature, timestamp, nonce });
        if (!ok) return new Response("invalid signature", { status: 403 });
      }
    }
    const xml = await request.text();
    return handleWechatMessage(env, xml);
  }
  throw new HttpError(405, "method not allowed");
}

async function handleApi(request, env, parts, url) {
  if (parts[0] === "test" && parts[1] === "token" && request.method === "POST") {
    if (env.ALLOW_TEST_TOKEN !== "true" && env.ALLOW_TEST_TOKEN !== "1") {
      throw new HttpError(404, "not found");
    }
    const input = await readJson(request);
    const sub = input.userId || input.sub || crypto.randomUUID();
    const token = await signJwtHs256(
      { sub, email: input.email || "test@example.com", services: input.services || [] },
      env.CF_AUTH_JWT_SECRET,
      { ttlSeconds: 3600, audience: env.CF_AUTH_JWT_AUDIENCE }
    );
    return json({ token, userId: sub });
  }

  // Reserved wechat login challenge (disabled unless flag on)
  if (parts[0] === "session" && parts[1] === "wechat" && parts[2] === "challenge" && request.method === "POST") {
    if (env.WECHAT_CODE_LOGIN_ENABLED !== "true" && env.WECHAT_CODE_LOGIN_ENABLED !== "1") {
      throw new HttpError(403, "wechat code login is disabled");
    }
    const input = await readJson(request);
    const result = await createBindCode(
      env.kv,
      {
        purpose: "wechat_login",
        channel: "wechat_oa",
        clientId: input.clientId || input.client_id,
        redirectUri: input.redirectUri || input.redirect_uri,
        state: input.state
      },
      { ttlSec: Number(env.BIND_CODE_TTL_SEC) || 300, loginEnabled: true }
    );
    return json({ ...result, qrcodeUrl: env.WECHAT_QRCODE_URL || null });
  }

  if (parts[0] === "admin") {
    await requireBootstrapAdmin(env, request);
    if (parts[1] === "clients") {
      if (request.method === "GET") return json({ clients: await listNotifyClients(env.db) });
      if (request.method === "POST") {
        const input = await readJson(request);
        requireFields(input, ["serviceId"]);
        const client = await createNotifyClient(env.db, input);
        return json({ client });
      }
    }
    if (parts[1] === "logs" && request.method === "GET") {
      const logs = await listLogs(env.db, {
        userId: url.searchParams.get("userId") || undefined,
        limit: Number(url.searchParams.get("limit") || 50)
      });
      return json({ logs });
    }
    if (parts[1] === "retry" && request.method === "POST") {
      const results = await retryFailedLogs(env, { limit: 20 });
      return json({ results });
    }
    if (parts[1] === "channel-apps" && request.method === "POST") {
      const input = await readJson(request);
      const id = await upsertChannelApp(env.db, input);
      return json({ id });
    }
    throw new HttpError(405, "method not allowed");
  }

  // User bindings
  if (parts[0] === "bindings") {
    const user = await requireUser(env, request);
    if (!parts[1] && request.method === "GET") {
      return json({ bindings: await listBindingsForUser(env.db, user.id) });
    }
    if (parts[1] === "code" && request.method === "POST") {
      const block = await assertBindCodeAllowed(env.kv, user.id, request);
      if (block) throw new HttpError(block.status, block.error, { retryAfterSec: block.retryAfterSec });
      const input = await readJson(request);
      const channel = input.channel || "wechat_oa";
      if (channel !== "wechat_oa") throw new HttpError(400, "only wechat_oa supported in Phase 1");
      const result = await createBindCode(
        env.kv,
        { userId: user.id, channel, purpose: "wechat_bind" },
        {
          ttlSec: Number(env.BIND_CODE_TTL_SEC) || 300,
          loginEnabled: env.WECHAT_CODE_LOGIN_ENABLED === "true"
        }
      );
      return json({
        ...result,
        qrcodeUrl: env.WECHAT_QRCODE_URL || null,
        hint: `请关注公众号后发送绑定码：${result.code}`
      });
    }
    if (parts[1] === "status" && request.method === "GET") {
      const code = url.searchParams.get("code") || "";
      if (!code) throw new HttpError(400, "code is required");
      const status = await getBindCodeStatus(env.kv, code);
      if (status.status === "expired") {
        const bindings = await listBindingsForUser(env.db, user.id);
        const wechat = bindings.find((b) => b.channel === "wechat_oa" && b.status === "verified");
        if (wechat) return json({ status: "verified", binding: wechat });
      }
      return json(status);
    }
    if (parts[1] && request.method === "DELETE") {
      const ok = await revokeBinding(env.db, parts[1], user.id);
      if (!ok) throw new HttpError(404, "binding not found");
      return json({ ok: true });
    }
    throw new HttpError(405, "method not allowed");
  }

  // Subscriptions
  if (parts[0] === "subscriptions") {
    const user = await requireUser(env, request);
    if (!parts[1] && request.method === "GET") {
      return json({ subscriptions: await listSubscriptions(env.db, user.id) });
    }
    if (!parts[1] && request.method === "POST") {
      const input = await readJson(request);
      requireFields(input, ["serviceId", "eventType"]);
      const sub = await upsertSubscription(env.db, {
        userId: user.id,
        serviceId: input.serviceId,
        eventType: input.eventType,
        channels: input.channels || ["wechat_oa"],
        enabled: input.enabled !== false
      });
      return json({ subscription: sub });
    }
    if (parts[1] && request.method === "DELETE") {
      const ok = await deleteSubscription(env.db, parts[1], user.id);
      if (!ok) throw new HttpError(404, "subscription not found");
      return json({ ok: true });
    }
    throw new HttpError(405, "method not allowed");
  }

  // Service send
  if (parts[0] === "v1" && parts[1] === "send" && request.method === "POST") {
    const client = await requireServiceClient(env.db, request);
    const input = await readJson(request);
    const result = await sendNotification(env, input, client);
    return json(result);
  }

  // Logs for current user
  if (parts[0] === "logs" && request.method === "GET") {
    const user = await requireUser(env, request);
    const logs = await listLogs(env.db, {
      userId: user.id,
      limit: Number(url.searchParams.get("limit") || 50)
    });
    return json({ logs });
  }

  throw new HttpError(404, "not found");
}

async function requireBootstrapAdmin(env, request) {
  const key = env.ADMIN_BOOTSTRAP_KEY;
  if (!key) throw new HttpError(404, "not found");
  const provided =
    request.headers.get("X-Admin-Bootstrap-Key") ||
    bearerToken(request);
  if (provided !== key) throw new HttpError(403, "forbidden");
}
