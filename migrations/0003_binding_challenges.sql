CREATE TABLE IF NOT EXISTS binding_challenges (
  token_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('wechat_bind', 'wechat_login')),
  user_id TEXT,
  channel TEXT NOT NULL,
  client_id TEXT,
  redirect_uri TEXT,
  state TEXT,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consumed_by TEXT,
  binding_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_binding_challenges_user
  ON binding_challenges(user_id, channel, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_binding_challenges_expiry
  ON binding_challenges(expires_at);

CREATE TABLE IF NOT EXISTS wechat_callback_receipts (
  receipt_hash TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wechat_callback_receipts_time
  ON wechat_callback_receipts(received_at);
