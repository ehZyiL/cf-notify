CREATE TABLE IF NOT EXISTS notification_events (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  locale TEXT,
  occurred_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'accepted'
    CHECK (status IN ('accepted', 'dispatching', 'completed', 'partially_failed', 'skipped', 'failed')),
  skip_reason TEXT,
  dispatch_queued_at TEXT,
  last_enqueue_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (service_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_events_user_time
  ON notification_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_reconcile
  ON notification_events(status, updated_at);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  binding_id TEXT,
  target_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'delivered', 'retrying', 'unknown', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  provider_message_id TEXT,
  error_code TEXT,
  error_detail TEXT,
  enqueued_at TEXT,
  last_enqueue_error TEXT,
  sent_at TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (event_id, channel, target_key)
);

CREATE INDEX IF NOT EXISTS idx_deliveries_event
  ON notification_deliveries(event_id, created_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_reconcile
  ON notification_deliveries(status, next_attempt_at, updated_at);
