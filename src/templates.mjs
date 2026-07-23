/**
 * Resolve template_id + data map from channel_apps.template_map_json
 *
 * template_map_json example:
 * {
 *   "worklog.failed": { "template_id": "TPL_xxx", "fields": { "thing1": "title", "thing2": "body" } },
 *   "*": { "template_id": "TPL_default", "fields": { "thing1": "title", "thing2": "body" } }
 * }
 */

export async function getChannelApp(db, channel = "wechat_oa") {
  const row = await db
    .prepare(
      `SELECT id, channel, name, app_id AS appId, template_map_json AS templateMapJson, enabled
       FROM channel_apps WHERE channel = ? AND enabled = 1 LIMIT 1`
    )
    .bind(channel)
    .first();
  return row || null;
}

export function resolveTemplate(templateMapJson, eventType, { title, body, data }) {
  let map = {};
  if (templateMapJson) {
    try {
      map = typeof templateMapJson === "string" ? JSON.parse(templateMapJson) : templateMapJson;
    } catch {
      map = {};
    }
  }
  const entry = map[eventType] || map["*"] || null;
  const templateId =
    data?.template_id ||
    data?.templateId ||
    entry?.template_id ||
    entry?.templateId ||
    null;

  if (data?.template || data?.data) {
    return {
      templateId: templateId || "DEFAULT_TEMPLATE",
      templateData: data.template || data.data
    };
  }

  if (entry?.fields) {
    const templateData = {};
    for (const [wxKey, src] of Object.entries(entry.fields)) {
      const value =
        src === "title" ? title : src === "body" ? body : data?.[src] ?? String(src);
      templateData[wxKey] = { value: String(value ?? "").slice(0, 20) };
    }
    return {
      templateId: templateId || "DEFAULT_TEMPLATE",
      templateData
    };
  }

  return {
    templateId: templateId || "DEFAULT_TEMPLATE",
    templateData: {
      thing1: { value: String(title || "通知").slice(0, 20) },
      thing2: { value: String(body || "-").slice(0, 20) }
    }
  };
}

export async function upsertChannelApp(db, input) {
  const now = new Date().toISOString();
  const channel = input.channel || "wechat_oa";
  const existing = await db
    .prepare("SELECT id FROM channel_apps WHERE channel = ? LIMIT 1")
    .bind(channel)
    .first();
  const templateMapJson =
    typeof input.templateMap === "string"
      ? input.templateMap
      : JSON.stringify(input.templateMap || input.template_map_json || {});
  if (existing) {
    await db
      .prepare(
        `UPDATE channel_apps SET name = ?, app_id = ?, template_map_json = ?, enabled = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(
        input.name || channel,
        input.appId || input.app_id || null,
        templateMapJson,
        input.enabled === false ? 0 : 1,
        now,
        existing.id
      )
      .run();
    return existing.id;
  }
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO channel_apps (id, channel, name, app_id, template_map_json, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
    )
    .bind(id, channel, input.name || channel, input.appId || null, templateMapJson, now, now)
    .run();
  return id;
}
