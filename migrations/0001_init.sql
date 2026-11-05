-- Taskivities schema. Single tenant.

-- People. The email is the only way in: sign-in succeeds only if the Google email matches a row here.
CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name        TEXT NOT NULL DEFAULT '',
  avatar_url  TEXT,
  color       TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  status      TEXT NOT NULL CHECK (status IN ('invited', 'active', 'removed')),
  added_by    TEXT,
  added_at    TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL,
  -- Mainly read by AI assistants (MCP clients) to decide where tasks belong.
  description TEXT NOT NULL DEFAULT '',
  archived    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX projects_name_active ON projects (name COLLATE NOCASE) WHERE archived = 0;

-- Members only; admins are implicitly on every project.
CREATE TABLE project_members (
  user_id    TEXT NOT NULL REFERENCES users (id),
  project_id TEXT NOT NULL REFERENCES projects (id),
  PRIMARY KEY (user_id, project_id)
);
CREATE INDEX project_members_project ON project_members (project_id);

-- Every task always has a project, a due date, an assignee and a priority.
CREATE TABLE tasks (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  notes       TEXT NOT NULL DEFAULT '',
  project_id  TEXT NOT NULL REFERENCES projects (id),
  assignee_id TEXT NOT NULL REFERENCES users (id),
  created_by  TEXT NOT NULL REFERENCES users (id),
  assigned_by TEXT NOT NULL REFERENCES users (id),
  due_date    TEXT NOT NULL,                       -- YYYY-MM-DD
  priority    INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 4), -- 1 urgent … 4 low
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  done_at     TEXT,                                -- ISO timestamp
  done_on     TEXT,                                -- YYYY-MM-DD in the team time zone
  done_by     TEXT REFERENCES users (id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  version     INTEGER NOT NULL                     -- meta.version at the last write (drives /api/sync)
);
CREATE INDEX tasks_assignee_due ON tasks (assignee_id, due_date);
CREATE INDEX tasks_project_done ON tasks (project_id, done_on);
CREATE INDEX tasks_status_due ON tasks (status, due_date);
CREATE INDEX tasks_version ON tasks (version);

-- The trace log. Append-only: the triggers below refuse updates and deletes.
CREATE TABLE task_events (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks (id),
  actor_id   TEXT NOT NULL REFERENCES users (id),
  via        TEXT,                                 -- e.g. 'Claude' when made by an MCP client
  type       TEXT NOT NULL,
  from_value TEXT,
  to_value   TEXT,
  note       TEXT,
  at         TEXT NOT NULL
);
CREATE INDEX task_events_task ON task_events (task_id, at);
CREATE TRIGGER task_events_no_update BEFORE UPDATE ON task_events
BEGIN SELECT RAISE(ABORT, 'task_events is append-only'); END;
CREATE TRIGGER task_events_no_delete BEFORE DELETE ON task_events
BEGIN SELECT RAISE(ABORT, 'task_events is append-only'); END;

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,                     -- SHA-256 of the cookie token
  user_id    TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

-- Admin actions: user_added, role_changed, projects_changed, user_removed, project_created, project_updated
CREATE TABLE audit_log (
  id       TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  action   TEXT NOT NULL,
  target   TEXT,
  detail   TEXT,
  at       TEXT NOT NULL
);

-- version: bumped on every task write. directory_version: bumped when people, projects or access change.
CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT INTO meta (key, value) VALUES ('version', 0), ('directory_version', 0);
