-- Web push (D-11 upgrade): one row per browser that turned on notifications.
-- The endpoint is the browser's own push address, so it is unique: the account
-- signed in on that device when it last subscribed owns it. keys is the
-- subscription's {p256dh, auth} as JSON.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint      TEXT NOT NULL UNIQUE,
  keys          TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions(user_id);
