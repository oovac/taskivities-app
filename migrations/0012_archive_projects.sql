-- Archiving a project (projects.archived has been there since 0001; now admins can set it). An archived project and all
-- its tasks are hidden from everyone until it's restored from the Team page. These record when and by whom.
ALTER TABLE projects ADD COLUMN archived_at TEXT;
ALTER TABLE projects ADD COLUMN archived_by TEXT REFERENCES users (id);
