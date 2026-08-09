-- Remove local-mode tables that are no longer needed in RPC mode.
-- Channel bindings, subscriptions, and legacy notification logs are
-- now managed exclusively by cf-auth via NotificationDirectory RPC.

DROP TABLE IF EXISTS notification_logs;
DROP TABLE IF EXISTS subscriptions;
DROP TABLE IF EXISTS channel_bindings;