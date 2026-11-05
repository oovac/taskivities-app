-- Admins who connect Gmail (Settings → Invite emails) so invites are emailed from their own address.
-- Only the gmail.send permission is requested: the app can send mail as them, never read it.
-- refresh_token is encrypted (AES-GCM, see worker/gmail.ts); disconnecting deletes the row and revokes it at Google.
CREATE TABLE google_tokens (
  user_id       TEXT PRIMARY KEY REFERENCES users (id),
  email         TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  scope         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
