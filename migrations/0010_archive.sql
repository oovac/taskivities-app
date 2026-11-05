-- Archiving instead of deleting: an archived task (open or done) disappears from every list and count, and can be
-- restored from the Projects page. Its history stays. A repeating task's series is paused while its open copy is archived.
ALTER TABLE tasks ADD COLUMN archived_at TEXT;
ALTER TABLE tasks ADD COLUMN archived_by TEXT REFERENCES users (id);
CREATE INDEX tasks_archived ON tasks (project_id, archived_at);
