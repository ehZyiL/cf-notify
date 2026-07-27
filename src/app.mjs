import {
  createNotifyClient,
  listNotifyClients,
  revokeNotifyClient
} from "./auth-service.mjs";
import { requireUser } from "./auth-user.mjs";
import {
  createBindCode,
  getBindCodeStatus,
  listBindingsForUser,
  revokeBinding
} from "./bindings.mjs";
import {
  claimWechatCallback,
  handleWechatMessage,
  isFreshWechatTimestamp,
  parseWechatXml,
  verifyWechatAesSignature,
  verifyWechatSignature
} from "./channels/wechat-callback.mjs";
import {
  claimWecomCallback,
  decryptWecomPayload,
  handleWecomMessage,
  isFreshWecomTimestamp,
  releaseWecomCallback,
  verifyWecomSignature
} from "./channels/wecom-callback.mjs";
import { bearerToken, HttpError, json, readJson, readText, requireFields, routeParts } from "./http.mjs";
import { assertBindCodeAllowed } from "./rate-limit.mjs";
import { listLogs, retryFailedLogs, sendNotification } from "./send.mjs";
import {
  deleteSubscription,
  listSubscriptions,
  upsertSubscription
} from "./subscriptions.mjs";
import { upsertChannelApp } from "./templates.mjs";
import { signJwtHs256, timingSafeSecretEqual } from "./crypto.mjs";
import {
  getEventStatusForService,
  ingestNotificationEvent,
  retryDelivery,
  retryFailedDeliveries
} from "./reliable-delivery.mjs";
import {
  createDirectoryBindingChallenge,
  getDirectoryBindingChallengeStatus,
  getEffectiveNotificationSettings,
  listDirectoryNotificationBindings,
  requireServiceIdentity,
  revokeDirectoryNotificationBinding,
  usesNotificationDirectoryRpc
} from "./notification-directory.mjs";
import {
  listChannelGuides,
  resetChannelGuide,
  saveChannelGuide
} from "./channel-guides.mjs";

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
      if (parts[0] === "wecom" && parts[1] === "callback") {
        return await handleWecomCallback(request, env, url);
      }

      if (parts[0] === "api") {
        return await handleApi(request, env, parts.slice(1), url);
      }

      if (parts[0] === "v1") {
        return await handleApi(request, env, parts, url);
      }

      throw new HttpError(404, "not found");
    } catch (error) {
      if (error instanceof HttpError) {
        const headers = {};
        if (error.details?.retryAfterSec) {
          headers["Retry-After"] = String(error.details.retryAfterSec);
        }
        return json(
          { ok: false, error: error.message, details: error.details },
          { status: error.status, headers }
        );
      }
      console.error(JSON.stringify({
        event: "http_request_failed",
        error: String(error?.message || error).slice(0, 500)
      }));
      return json(
        { ok: false, error: "internal server error" },
        { status: 500 }
      );
    }
  };
}

function publicBinding(binding) {
  const externalId = String(binding.externalId || "");
  const maskedLabel = externalId
    ? `${externalId.slice(0, 2)}***${externalId.slice(-4)}`
    : null;
  const { externalId: _externalId, ...safe } = binding;
  return { ...safe, maskedLabel };
}

function userHasService(user, serviceId) {
  const wanted = String(serviceId || "").toLowerCase();
  return (user.services || []).some((service) => {
    const id = typeof service === "string" ? service : service?.id || service?.serviceId;
    return String(id || "").toLowerCase() === wanted;
  });
}

async function handleWechatCallback(request, env, url) {
  const token = env.WECHAT_TOKEN || "";
  if (!token) throw new HttpError(503, "wechat callback is not configured");
  const timestamp = url.searchParams.get("timestamp") || "";
  const nonce = url.searchParams.get("nonce") || "";
  const maxSkewSec = Number(env.WECHAT_CALLBACK_MAX_SKEW_SEC || 300);
  if (!isFreshWechatTimestamp(timestamp, { maxSkewSec })) {
    return new Response("stale timestamp", { status: 403 });
  }
  if (request.method === "GET") {
    const signature = url.searchParams.get("signature") || "";
    const echostr = url.searchParams.get("echostr") || "";
    const ok = await verifyWechatSignature(token, { signature, timestamp, nonce });
    if (!ok) return new Response("invalid signature", { status: 403 });
    return new Response(echostr, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  if (request.method === "POST") {
    const xml = await readText(request, { maxBytes: 128 * 1024 });
    const encrypted = url.searchParams.get("encrypt_type") === "aes";
    const signature = encrypted
      ? url.searchParams.get("msg_signature") || ""
      : url.searchParams.get("signature") || "";
    const valid = encrypted
      ? await verifyWechatAesSignature(token, {
          msgSignature: signature,
          timestamp,
          nonce,
          encrypt: parseWechatXml(xml).Encrypt
        })
      : await verifyWechatSignature(token, { signature, timestamp, nonce });
    if (!valid) return new Response("invalid signature", { status: 403 });
    const claimed = await claimWechatCallback(env.db, { signature, timestamp, nonce, body: xml });
    if (!claimed) {
      return new Response("success", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    return handleWechatMessage(env, xml);
  }
  throw new HttpError(405, "method not allowed");
}

async function handleWecomCallback(request, env, url) {
  const token = env.WECOM_CALLBACK_TOKEN || "";
  if (!token || !env.WECOM_ENCODING_AES_KEY || !env.WECOM_CORP_ID) {
    throw new HttpError(503, "WeCom callback is not configured");
  }
  const timestamp = url.searchParams.get("timestamp") || "";
  const nonce = url.searchParams.get("nonce") || "";
  const signature = url.searchParams.get("msg_signature") || "";
  const maxSkewSec = Number(env.WECOM_CALLBACK_MAX_SKEW_SEC || 300);
  if (!isFreshWecomTimestamp(timestamp, { maxSkewSec })) {
    return new Response("stale timestamp", { status: 403 });
  }
  if (request.method === "GET") {
    const echo = url.searchParams.get("echostr") || "";
    if (!await verifyWecomSignature(token, {
      msgSignature: signature,
      timestamp,
      nonce,
      encrypt: echo
    })) {
      return new Response("invalid signature", { status: 403 });
    }
    return new Response(await decryptWecomPayload(echo, env), {
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }
  if (request.method === "POST") {
    const xml = await readText(request, { maxBytes: 128 * 1024 });
    const encrypt = parseWechatXml(xml).Encrypt;
    if (!await verifyWecomSignature(token, {
      msgSignature: signature,
      timestamp,
      nonce,
      encrypt
    })) {
      return new Response("invalid signature", { status: 403 });
    }
    const receipt = { signature, timestamp, nonce, body: xml };
    if (!await claimWecomCallback(env.db, receipt)) {
      return new Response("success");
    }
    try {
      return await handleWecomMessage(env, xml);
    } catch (error) {
      const retryable = !(error instanceof HttpError) || error.status >= 500;
      if (retryable) {
        try {
          await releaseWecomCallback(env.db, receipt);
        } catch (releaseError) {
          console.error(JSON.stringify({
            event: "wecom_callback_receipt_release_failed",
            error: String(releaseError?.message || releaseError).slice(0, 300)
          }));
        }
      }
      throw error;
    }
  }
  throw new HttpError(405, "method not allowed");
}

async function handleApi(request, env, parts, url) {
  if (parts[0] === "channel-guides" && request.method === "GET") {
    return json(
      { guides: await listChannelGuides(env) },
      {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=60",
          "Cross-Origin-Resource-Policy": "cross-origin"
        }
      }
    );
  }

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
      env.db,
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
    if (parts[1] === "channel-guides") {
      if (!parts[2] && request.method === "GET") {
        return json({ guides: await listChannelGuides(env, { includeDisabled: true }) });
      }
      if (parts[2] && request.method === "PUT") {
        const guide = await saveChannelGuide(env, parts[2], await readJson(request));
        return json({ guide });
      }
      if (parts[2] && request.method === "DELETE") {
        return json({ guide: await resetChannelGuide(env, parts[2]) });
      }
      throw new HttpError(405, "method not allowed");
    }
    if (parts[1] === "clients") {
      if (!parts[2] && request.method === "GET") return json({ clients: await listNotifyClients(env.db) });
      if (!parts[2] && request.method === "POST") {
        const input = await readJson(request);
        requireFields(input, ["serviceId"]);
        const client = await createNotifyClient(env.db, input);
        return json({ client });
      }
      if (parts[2] && request.method === "DELETE") {
        const revoked = await revokeNotifyClient(env.db, parts[2]);
        if (!revoked) throw new HttpError(404, "client not found or already revoked");
        return json({ ok: true, clientId: parts[2] });
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
      const [legacy, reliable] = await Promise.all([
        retryFailedLogs(env, { limit: 20 }),
        retryFailedDeliveries(env, { limit: 20 })
      ]);
      const results = [
        ...legacy.map((item) => ({ source: "legacy", ...item })),
        ...reliable.map((item) => ({ source: "delivery", ...item }))
      ];
      return json({ results });
    }
    if (parts[1] === "deliveries" && parts[2] && parts[3] === "retry" && request.method === "POST") {
      const queued = await retryDelivery(env, parts[2]);
      if (!queued) throw new HttpError(404, "delivery not found or queue unavailable");
      return json({ ok: true, deliveryId: parts[2], queued });
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
      if (usesNotificationDirectoryRpc(env)) {
        return json({ bindings: await listDirectoryNotificationBindings(env, user.id) });
      }
      const bindings = await listBindingsForUser(env.db, user.id);
      return json({ bindings: bindings.map(publicBinding) });
    }
    if (parts[1] === "code" && request.method === "POST") {
      const block = await assertBindCodeAllowed(env.kv, user.id, request);
      if (block) throw new HttpError(block.status, block.error, { retryAfterSec: block.retryAfterSec });
      const input = await readJson(request);
      const channel = input.channel || "wechat_oa";
      if (!["wechat_oa", "wecom"].includes(channel)) {
        throw new HttpError(400, "notification channel is not supported");
      }
      if (channel === "wecom" && !usesNotificationDirectoryRpc(env)) {
        throw new HttpError(409, "WeCom binding requires cf-auth notification directory RPC");
      }
      if (usesNotificationDirectoryRpc(env)) {
        const providerAccountId = channel === "wecom"
          ? env.WECOM_PROVIDER_ACCOUNT_ID || "wecom-main"
          : env.WECHAT_PROVIDER_ACCOUNT_ID || env.WECHAT_APP_ID || "default";
        const challenge = await createDirectoryBindingChallenge(env, {
          userId: user.id,
          channel,
          providerAccountId,
          purpose: "bind",
          context: { initiatedBy: "cf_notify_account_center" }
        });
        return json({
          code: challenge.token,
          expiresAt: challenge.expiresAt,
          expireIn: challenge.expireIn,
          qrcodeUrl: channel === "wecom" ? env.WECOM_APP_URL || null : env.WECHAT_QRCODE_URL || null,
          hint: channel === "wecom"
            ? `请在企业微信应用中发送绑定码：${challenge.token}`
            : `请关注公众号后发送绑定码：${challenge.token}`
        });
      }
      const result = await createBindCode(
        env.db,
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
      if (usesNotificationDirectoryRpc(env)) {
        return json(await getDirectoryBindingChallengeStatus(env, {
          token: code,
          userId: user.id
        }));
      }
      const status = await getBindCodeStatus(env.db, code, { userId: user.id });
      if (status.status === "expired") {
        const bindings = await listBindingsForUser(env.db, user.id);
        const wechat = bindings.find((b) => b.channel === "wechat_oa" && b.status === "verified");
        if (wechat) return json({ status: "verified", binding: publicBinding(wechat) });
      }
      return json(status);
    }
    if (parts[1] && request.method === "DELETE") {
      if (usesNotificationDirectoryRpc(env)) {
        const result = await revokeDirectoryNotificationBinding(env, {
          bindingId: parts[1],
          userId: user.id
        });
        if (!result?.ok) throw new HttpError(404, "binding not found");
        return json({ ok: true });
      }
      const ok = await revokeBinding(env.db, parts[1], user.id);
      if (!ok) throw new HttpError(404, "binding not found");
      return json({ ok: true });
    }
    throw new HttpError(405, "method not allowed");
  }

  // Subscriptions
  if (parts[0] === "subscriptions") {
    const user = await requireUser(env, request);
    if (usesNotificationDirectoryRpc(env)) {
      throw new HttpError(409, "notification preferences are managed in cf-auth account center");
    }
    if (!parts[1] && request.method === "GET") {
      return json({ subscriptions: await listSubscriptions(env.db, user.id) });
    }
    if (!parts[1] && request.method === "POST") {
      const input = await readJson(request);
      requireFields(input, ["serviceId", "eventType"]);
      if (env.ENFORCE_USER_SERVICE_MEMBERSHIP !== "false" && !userHasService(user, input.serviceId)) {
        throw new HttpError(403, "user is not assigned to this service");
      }
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

  // Reliable service event API.
  if (
    parts[0] === "v1" &&
    parts[1] === "users" &&
    parts[2] &&
    parts[3] === "notification-settings" &&
    request.method === "GET"
  ) {
    const client = await requireServiceIdentity(env, request, {
      scope: "notifications.settings.read"
    });
    const eventType = String(url.searchParams.get("eventType") || "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(eventType)) {
      throw new HttpError(400, "eventType is invalid");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(parts[2])) {
      throw new HttpError(400, "userId is invalid");
    }
    return json(await getEffectiveNotificationSettings(env, {
      serviceId: client.serviceId,
      userId: parts[2],
      eventType
    }));
  }

  if (parts[0] === "v1" && parts[1] === "notifications") {
    const requiredScope = request.method === "GET"
      ? "notifications.delivery.read"
      : "notifications.send";
    const client = await requireServiceIdentity(env, request, { scope: requiredScope });
    if (!parts[2] && request.method === "POST") {
      const input = await readJson(request);
      const result = await ingestNotificationEvent(
        env,
        input,
        client,
        request.headers.get("Idempotency-Key")
      );
      return json(result, { status: 202 });
    }
    if (parts[2] && request.method === "GET") {
      const result = await getEventStatusForService(env.db, parts[2], client.serviceId);
      if (!result) throw new HttpError(404, "notification event not found");
      return json(result);
    }
    throw new HttpError(405, "method not allowed");
  }

  // Backwards-compatible send path. Production uses the reliable queue when configured.
  if (parts[0] === "v1" && parts[1] === "send" && request.method === "POST") {
    const client = await requireServiceIdentity(env, request, { scope: "notifications.send" });
    const input = await readJson(request);
    if (env.dispatchQueue) {
      const result = await ingestNotificationEvent(
        env,
        input,
        client,
        request.headers.get("Idempotency-Key")
      );
      return json(result, { status: 202 });
    }
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
  if (!(await timingSafeSecretEqual(provided, key))) throw new HttpError(403, "forbidden");
}
