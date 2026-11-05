-- One-time upload links for AI assistants (MCP get_upload_url): POST a file to /upload/<secret> to attach it.
-- Only a hash of the secret is stored. A link works once, for 15 minutes, as the person who asked for it.
CREATE TABLE upload_links (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks (id),
  user_id       TEXT NOT NULL REFERENCES users (id),
  via           TEXT,
  name          TEXT,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  used_at       TEXT,
  attachment_id TEXT
);
