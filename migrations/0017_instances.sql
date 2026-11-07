-- Several instances in one app (src/sources.ts): the app signs in to other Taskivities instances as you (OAuth, as AI
-- assistants do) and talks to their /v1 API directly. The servers stay single-tenant; the only server-side pieces are
-- for notifications, which arrive through your home instance:
--
--   push_relays (on every instance): besides this browser's push subscriptions, where to send a person's notifications:
--     the relay their home instance runs for them. Added by their app when it connects; removed when a relay answers
--     404/410 (they disconnected).
--   relays (on a home instance): the relays it runs for its people, one per instance they connected. The secret is
--     in the URL (only its hash is kept here). A relay passes what it receives to that person's devices, with this
--     instance's push key, and lists which instances someone connected (so a new device can reconnect in one tap).
CREATE TABLE push_relays (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id),
  url        TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_ok_at TEXT,
  UNIQUE (user_id, url)
);

CREATE TABLE relays (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id),
  origin      TEXT NOT NULL,     -- the other instance, e.g. https://work.example.com
  remote_user TEXT NOT NULL,     -- JSON: who you are there ({ id, name }): one connection per instance, on every device
  secret_hash TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  last_at     TEXT               -- when it last passed a notification on
);
CREATE UNIQUE INDEX relays_user_origin ON relays (user_id, origin);
