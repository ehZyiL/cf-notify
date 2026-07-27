CREATE TABLE IF NOT EXISTS wecom_callback_receipts (
  receipt_hash TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wecom_callback_receipts_time
  ON wecom_callback_receipts(received_at);
