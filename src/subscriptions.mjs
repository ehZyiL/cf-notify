function nowIso() {
  return new Date().toISOString();
}

function mapSub(row) {
  if (!row) return null;
  let channels = ["wechat_oa"];
  try {
    channels = JSON.parse(row.channels_json || row.channelsJson || "[]");
  } catch {
    /* default */
  }
  if (!Array.isArray(channels) || !channels.length) channels = ["wechat_oa"];
  return {
    id: row.id,
    userId: row.user_id ?? row.userId,
    serviceId: row.service_id ?? row.serviceId,
    eventType: row.event_type ?? row.eventType,
    channels,
    enabled: Number(row.enabled) === 1 || row.enabled === true,
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt
  };
}

export async function listSubscriptions(db, userId) {
  const { results } = await db
    .prepare(
      `SELECT id, user_id, service_id, event_type, channels_json, enabled, created_at, updated_at
       FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC`
    )
    .bind(userId)
    .all();
  return (results || []).map(mapSub);
}

export async function upsertSubscription(db, { userId, serviceId, eventType, channels, enabled = true }) {
  const existing = await db
    .prepare(
      `SELECT id FROM subscriptions WHERE user_id = ? AND service_id = ? AND event_type = ?`
    )
    .bind(userId, serviceId, eventType)
    .first();
  const now = nowIso();
  const channelsJson = JSON.stringify(channels || ["wechat_oa"]);
  if (existing) {
    await db
      .prepare(
        `UPDATE subscriptions SET channels_json = ?, enabled = ?, updated_at = ? WHERE id = ?`
      )
      .bind(channelsJson, enabled ? 1 : 0, now, existing.id)
      .run();
    return getSubscription(db, existing.id);
  }
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO subscriptions (id, user_id, service_id, event_type, channels_json, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, userId, serviceId, eventType, channelsJson, enabled ? 1 : 0, now, now)
    .run();
  return getSubscription(db, id);
}

export async function getSubscription(db, id) {
  const row = await db
    .prepare(
      `SELECT id, user_id, service_id, event_type, channels_json, enabled, created_at, updated_at
       FROM subscriptions WHERE id = ?`
    )
    .bind(id)
    .first();
  return mapSub(row);
}

/**
 * Whether user wants this event.
 * P1 default: no row means allow all (bind-and-receive).
 * If any row exists for user+service, require matching enabled subscription
 * (exact event or event_type '*').
 */
export async function isSubscribed(db, { userId, serviceId, eventType }) {
  const { results } = await db
    .prepare(
      `SELECT event_type, enabled FROM subscriptions
       WHERE user_id = ? AND (service_id = ? OR service_id = '*')`
    )
    .bind(userId, serviceId)
    .all();
  const rows = results || [];
  if (rows.length === 0) return true; // default open

  for (const row of rows) {
    if (Number(row.enabled) !== 1) continue;
    if (row.event_type === "*" || row.event_type === eventType) return true;
  }
  // has subscriptions but none match/enabled
  return false;
}

/** Resolve requested channels against the user's current event preferences. */
export async function resolveSubscribedChannels(
  db,
  { userId, serviceId, eventType, channels, defaultOpen = true }
) {
  const requested = [...new Set((channels || ["wechat_oa"]).map(String))];
  const { results } = await db
    .prepare(
      `SELECT event_type, channels_json, enabled FROM subscriptions
       WHERE user_id = ? AND (service_id = ? OR service_id = '*')`
    )
    .bind(userId, serviceId)
    .all();
  const rows = results || [];
  if (rows.length === 0) return defaultOpen ? requested : [];

  const matching = rows.filter(
    (row) => Number(row.enabled) === 1 && (row.event_type === eventType || row.event_type === "*")
  );
  if (!matching.length) return [];

  const allowed = new Set();
  for (const row of matching) {
    let configured = [];
    try {
      configured = JSON.parse(row.channels_json || "[]");
    } catch {
      configured = [];
    }
    if (Array.isArray(configured)) configured.forEach((channel) => allowed.add(String(channel)));
  }
  return requested.filter((channel) => allowed.has(channel));
}

export async function isChannelSubscribed(db, input) {
  const channels = await resolveSubscribedChannels(db, {
    ...input,
    channels: [input.channel]
  });
  return channels.includes(input.channel);
}

export async function deleteSubscription(db, id, userId) {
  const row = await getSubscription(db, id);
  if (!row || row.userId !== userId) return false;
  await db.prepare("DELETE FROM subscriptions WHERE id = ?").bind(id).run();
  return true;
}
