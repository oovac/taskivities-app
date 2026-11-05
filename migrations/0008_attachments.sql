-- Files attached to tasks. The bytes live in R2 (binding FILES, one bucket per instance) under `key`;
-- this table is the list. Removing a file deletes it from R2 and sets removed_at (the history keeps its name).
CREATE TABLE attachments (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks (id),
  key         TEXT NOT NULL,
  name        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  type        TEXT NOT NULL,
  uploaded_by TEXT NOT NULL REFERENCES users (id),
  uploaded_at TEXT NOT NULL,
  removed_by  TEXT REFERENCES users (id),
  removed_at  TEXT
);
CREATE INDEX attachments_by_task ON attachments (task_id, uploaded_at);
