-- One checklist per task: its items, in order. Every change is also logged in task_events.
-- Repeating tasks: the next copy starts with the same items, unchecked.
CREATE TABLE checklist_items (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks (id),
  text       TEXT NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0,
  position   REAL NOT NULL,
  created_by TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  done_by    TEXT REFERENCES users (id),
  done_at    TEXT
);
CREATE INDEX checklist_by_task ON checklist_items (task_id, position);
