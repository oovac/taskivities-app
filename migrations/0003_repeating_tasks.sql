-- Repeating tasks. A series holds the repeat rule and the defaults for future copies; each copy is an ordinary task
-- (with its own history) that points at its series. Only one copy is open at a time: finishing it creates the next
-- one in the same batch (worker/tasks.ts). No scheduled job is involved.
CREATE TABLE series (
  id          TEXT PRIMARY KEY,
  rule        TEXT NOT NULL,                       -- JSON, see shared/repeat.ts
  starts_on   TEXT NOT NULL,                       -- YYYY-MM-DD the schedule counts from
  title       TEXT NOT NULL,
  notes       TEXT NOT NULL DEFAULT '',
  project_id  TEXT NOT NULL REFERENCES projects (id),
  assignee_id TEXT NOT NULL REFERENCES users (id),
  priority    INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 4),
  made        INTEGER NOT NULL DEFAULT 1,          -- copies used so far (created or skipped), for "after N times"
  active      INTEGER NOT NULL DEFAULT 1,          -- 0 once stopped or finished
  created_by  TEXT NOT NULL REFERENCES users (id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX series_assignee ON series (assignee_id, active);

ALTER TABLE tasks ADD COLUMN series_id TEXT REFERENCES series (id);
CREATE INDEX tasks_series ON tasks (series_id, status);
