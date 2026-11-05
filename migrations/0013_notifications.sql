-- Phone and desktop notifications (Web Push). One row per device that turned notifications on; a person can have
-- several. The endpoint is the push service's address for that device; p256dh and auth are its encryption keys.
-- `origin` is the app address it subscribed from (used as the sender contact). Rows are deleted when the push
-- service says the device is gone, when it turns notifications off, and when the person is disabled.
CREATE TABLE push_subscriptions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id),
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  origin      TEXT NOT NULL,
  user_agent  TEXT,
  created_at  TEXT NOT NULL,
  last_ok_at  TEXT
);
CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id);

-- What each person wants to hear about (JSON {"assigned","comments","morning"}; NULL = all on), and the day their
-- morning summary was last sent (YYYY-MM-DD in their time zone), so it goes out once a day.
ALTER TABLE users ADD COLUMN notify TEXT;
ALTER TABLE users ADD COLUMN morning_sent_on TEXT;
