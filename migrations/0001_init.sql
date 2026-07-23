CREATE TABLE IF NOT EXISTS notify_clients (
  client_id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  name TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_bindings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  external_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'verified'
    CHECK (status IN ('pending', 'verified', 'revoked')),
  meta_json TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (channel, external_id)
);
CREATE INDEX IF NOT EXISTS idx_bindings_user ON channel_bindings(user_id);
CREATE INDEX IF NOT EXISTS idx_bindings_user_ch ON channel_bindings(user_id, channel);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  channels_json TEXT NOT NULL DEFAULT '["wechat_oa"]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, service_id, event_type)
);

CREATE TABLE IF NOT EXISTS notification_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  service_id TEXT,
  client_id TEXT,
  event_type TEXT,
  channel TEXT,
  status TEXT NOT NULL,
  provider_msg_id TEXT,
  error TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_user_time ON notification_logs(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS channel_apps (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  name TEXT NOT NULL,
  app_id TEXT,
  template_map_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
