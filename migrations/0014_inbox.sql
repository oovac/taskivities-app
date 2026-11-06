-- The inbox (the bell in the top bar): what other people did that needs you — tasks given to you, comments on your
-- tasks, handovers. It isn't stored separately: it's read from task_events (the history every task already keeps),
-- so nothing here grows with it. These are the indexes that find one person's part of the history quickly, and the
-- time each person last opened their inbox (newer entries are unread).
ALTER TABLE users ADD COLUMN inbox_read_at TEXT;
-- People who are here now start with nothing unread; people invited later see what was given to them before they joined.
UPDATE users SET inbox_read_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

-- Tasks handed to someone (to_value is who got it) and new tasks made for someone (to_value is JSON with "assignee").
CREATE INDEX task_events_transferred_to ON task_events (to_value, at) WHERE type = 'transferred';
CREATE INDEX task_events_created_for ON task_events (json_extract(to_value, '$.assignee'), at) WHERE type = 'created';
-- Comments reach whoever has the task and whoever created it.
CREATE INDEX tasks_created_by ON tasks (created_by);
