-- People are disabled, not removed: a disabled person can't sign in (and their assistants lose access), but they stay
-- on the Team page with their projects remembered, and an admin can enable them again. The status 'removed' becomes
-- 'disabled'. SQLite can't change a CHECK constraint in place, so the table is rebuilt (foreign keys are checked at
-- the end, once the new table has the same rows under the same name).
PRAGMA defer_foreign_keys = on;

CREATE TABLE users_new (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name         TEXT NOT NULL DEFAULT '',
  avatar_url   TEXT,
  color        TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  status       TEXT NOT NULL CHECK (status IN ('invited', 'active', 'disabled')),
  added_by     TEXT,
  added_at     TEXT NOT NULL,
  last_seen_at TEXT,
  time_zone    TEXT,
  disabled_at  TEXT,
  disabled_by  TEXT
);

INSERT INTO users_new (id, email, name, avatar_url, color, role, status, added_by, added_at, last_seen_at, time_zone, disabled_at)
SELECT id, email, name, avatar_url, color, role, CASE status WHEN 'removed' THEN 'disabled' ELSE status END,
       added_by, added_at, last_seen_at, time_zone,
       CASE status WHEN 'removed' THEN COALESCE((SELECT MAX(at) FROM audit_log WHERE action = 'user_removed' AND target = users.id), added_at) END
FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

PRAGMA defer_foreign_keys = off;
