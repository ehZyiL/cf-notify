import {
  createNotifyClient,
  listNotifyClients,
  revokeNotifyClient
} from "./auth-service.mjs";
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
import { HttpError, json, readJson, readText, requireFields, routeParts } from "./http.mjs";
import { listLogs } from "./send.mjs";
import { upsertChannelApp } from "./templates.mjs";
import {
  getDeliveryRetryCandidate,
  getEventStatusForService,
  ingestNotificationEvent,
  listDeliveryRetryCandidates,
  retryDelivery,
} from "./reliable-delivery.mjs";
import {
  getEffectiveNotificationSettings,
  requireServiceIdentity,
  usesNotificationDirectoryRpc
} from "./notification-directory.mjs";
import {
  listChannelGuides,
  resetChannelGuide,
  saveChannelGuide
} from "./channel-guides.mjs";
import { getChannelCapability, listChannelCapabilities } from "./channel-capabilities.mjs";
import { getAdminReadiness, getProductRuntime } from "./product-status.mjs";
import {
  endAdminSession,
  finishAdminLogin,
  getAdminSession,
  requireAdminSession,
  startAdminLogin
} from "./admin-auth.mjs";

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
    const allGuides = await listChannelGuides(env, { includeDisabled: true });
    const channels = listChannelCapabilities(env, allGuides);
    const available = new Set(channels.filter((channel) => channel.available).map((channel) => channel.channel));
    return json(
      {
        guides: allGuides.filter((guide) => available.has(guide.channel)),
        channels
      },
      {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=60",
          "Cross-Origin-Resource-Policy": "cross-origin"
        }
      }
    );
  }

  if (parts[0] === "admin") {
    if (parts[1] === "auth" && parts[2] === "login" && request.method === "GET") {
      return startAdminLogin(request, env);
    }
    if (parts[1] === "auth" && parts[2] === "callback" && request.method === "GET") {
      return finishAdminLogin(request, env);
    }
    if (parts[1] === "session" && request.method === "GET") {
      return json(await getAdminSession(request, env), {
        headers: { "Cache-Control": "no-store", Pragma: "no-cache" }
      });
    }
    if (parts[1] === "session" && request.method === "DELETE") {
      return endAdminSession(request, env);
    }
    const adminSession = await requireAdminSession(env, request);
    if (parts[1] === "runtime" && request.method === "GET") {
      return json(await getProductRuntime(env));
    }
    if (parts[1] === "readiness" && request.method === "GET") {
      return json(await getAdminReadiness(env));
    }
    if (parts[1] === "channel-guides") {
      if (!parts[2] && request.method === "GET") {
        const guides = await listChannelGuides(env, { includeDisabled: true });
        return json({ guides, channels: listChannelCapabilities(env, guides) });
      }
      if (parts[2] && request.method === "PUT") {
        const guide = await saveChannelGuide(env, parts[2], await readJson(request));
        return json({ guide, capability: getChannelCapability(env, guide) });
      }
      if (parts[2] && request.method === "DELETE") {
        const guide = await resetChannelGuide(env, parts[2]);
        return json({ guide, capability: getChannelCapability(env, guide) });
      }
      throw new HttpError(405, "method not allowed");
    }
    if (parts[1] === "clients") {
      if (usesNotificationDirectoryRpc(env)) {
        if (!parts[2] && request.method === "GET") {
          return json({ clients: [], managedBy: "cf-auth", writable: false });
        }
        throw new HttpError(409, "service credentials are managed by cf-auth in rpc mode", {
          managedBy: "cf-auth"
        });
      }
      if (!parts[2] && request.method === "GET") {
        return json({ clients: await listNotifyClients(env.db), managedBy: "cf-notify", writable: true });
      }
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
      const input = await readJson(request);
      const candidates = await listDeliveryRetryCandidates(env.db, { limit: 50 });
      if (input.confirm !== true) {
        return json({
          dryRun: true,
          candidates,
          message: "select deliveryIds and explicitly confirm before retrying"
        });
      }
      const deliveryIds = [...new Set(
        (Array.isArray(input.deliveryIds) ? input.deliveryIds : [])
          .map((value) => String(value || "").trim())
          .filter(Boolean)
      )];
      if (!deliveryIds.length || deliveryIds.length > 20) {
        throw new HttpError(400, "deliveryIds must contain between 1 and 20 items");
      }
      const selected = [];
      for (const deliveryId of deliveryIds) {
        const candidate = await getDeliveryRetryCandidate(env.db, deliveryId);
        if (!candidate) throw new HttpError(404, `delivery not found: ${deliveryId}`);
        if (!candidate.canRetry) {
          throw new HttpError(409, `delivery requires configuration repair before retry: ${deliveryId}`, {
            deliveryId,
            reason: candidate.reason,
            errorCode: candidate.errorCode
          });
        }
        if (candidate.duplicateRisk && input.acknowledgeUnknownDuplicateRisk !== true) {
          throw new HttpError(409, "unknown provider outcomes may create duplicate notifications", {
            deliveryId,
            acknowledgeField: "acknowledgeUnknownDuplicateRisk"
          });
        }
        selected.push(candidate);
      }
      const results = [];
      for (const candidate of selected) {
        results.push({
          deliveryId: candidate.deliveryId,
          queued: await retryDelivery(env, candidate.deliveryId, {
            acknowledgeUnknownDuplicateRisk: input.acknowledgeUnknownDuplicateRisk === true
          })
        });
      }
      console.log(JSON.stringify({
        event: "admin_delivery_retry_batch",
        actorUserId: adminSession.admin.userId,
        deliveryIds,
        count: deliveryIds.length
      }));
      return json({ dryRun: false, results });
    }
    if (parts[1] === "deliveries" && parts[2] && parts[3] === "retry" && request.method === "POST") {
      const input = await readJson(request);
      const candidate = await getDeliveryRetryCandidate(env.db, parts[2]);
      if (!candidate) throw new HttpError(404, "delivery not found");
      if (!candidate.canRetry) {
        throw new HttpError(409, "delivery requires configuration repair before retry", {
          deliveryId: candidate.deliveryId,
          reason: candidate.reason,
          errorCode: candidate.errorCode
        });
      }
      if (candidate.duplicateRisk && input.acknowledgeUnknownDuplicateRisk !== true) {
        throw new HttpError(409, "unknown provider outcomes may create duplicate notifications", {
          deliveryId: candidate.deliveryId,
          acknowledgeField: "acknowledgeUnknownDuplicateRisk"
        });
      }
      const queued = await retryDelivery(env, parts[2], {
        acknowledgeUnknownDuplicateRisk: input.acknowledgeUnknownDuplicateRisk === true
      });
      if (!queued) {
        const latest = await getDeliveryRetryCandidate(env.db, parts[2]);
        if (latest && ["pending", "retrying", "sending"].includes(latest.status)) {
          throw new HttpError(409, "delivery is already queued for retry");
        }
        throw new HttpError(503, "delivery could not be queued and remains eligible for retry");
      }
      console.log(JSON.stringify({
        event: "admin_delivery_retry",
        actorUserId: adminSession.admin.userId,
        deliveryId: parts[2],
        previousStatus: candidate.status,
        duplicateRisk: candidate.duplicateRisk
      }));
      return json({ ok: true, deliveryId: parts[2], queued, duplicateRisk: candidate.duplicateRisk });
    }
    if (parts[1] === "channel-apps" && request.method === "POST") {
      const input = await readJson(request);
      const id = await upsertChannelApp(env.db, input);
      return json({ id });
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
    throw new HttpError(503, "synchronous send is unavailable; configure dispatch queue");
  }

  throw new HttpError(404, "not found");
}
