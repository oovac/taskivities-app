-- Webhooks (Settings → Webhooks). Each has a secret URL: POST /hooks/<token>.
-- mapping NULL = capturing: requests are only stored, so an admin can build the mapping from a real sample.
-- With a mapping (shared/webhook.ts) each request creates a task, made as `created_by` ("via <name> webhook").
CREATE TABLE webhooks (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  token            TEXT NOT NULL UNIQUE,
  mapping          TEXT,
  active           INTEGER NOT NULL DEFAULT 1,
  created_by       TEXT NOT NULL REFERENCES users (id),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  last_received_at TEXT
);

-- The most recent requests per webhook (older ones are pruned), with what happened to each.
-- result: captured · created · skipped · duplicate · error · paused
CREATE TABLE webhook_requests (
  id          TEXT PRIMARY KEY,
  webhook_id  TEXT NOT NULL REFERENCES webhooks (id) ON DELETE CASCADE,
  received_at TEXT NOT NULL,
  method      TEXT NOT NULL,
  content_type TEXT,
  headers     TEXT NOT NULL,
  query       TEXT NOT NULL,
  body        TEXT NOT NULL,
  result      TEXT NOT NULL,
  detail      TEXT,
  task_id     TEXT
);
CREATE INDEX webhook_requests_by_hook ON webhook_requests (webhook_id, received_at);

-- "Skip duplicates": which keys already made a task, kept even after the request log is pruned.
CREATE TABLE webhook_keys (
  webhook_id TEXT NOT NULL REFERENCES webhooks (id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  task_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (webhook_id, key)
);
