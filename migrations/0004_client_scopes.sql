ALTER TABLE notify_clients ADD COLUMN scopes_json TEXT NOT NULL
  DEFAULT '["notifications.send","notifications.delivery.read"]';
ALTER TABLE notify_clients ADD COLUMN expires_at TEXT;
