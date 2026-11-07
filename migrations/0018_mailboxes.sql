-- Invite emails go out from the inviting admin's own mailbox: Gmail or Outlook (Microsoft 365). One per admin: the
-- primary key makes connecting one replace the other. Only "send" permission is ever asked for, never "read".
-- refresh_token is encrypted (AES-GCM, worker/token-crypto.ts), with a key per provider. See worker/mailbox.ts.
CREATE TABLE mailboxes (
  user_id       TEXT PRIMARY KEY REFERENCES users (id),
  via           TEXT NOT NULL CHECK (via IN ('gmail', 'outlook')),
  email         TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  scope         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Gmail connections made so far (0005) carry over as they are: same encryption, so nobody has to connect again.
INSERT INTO mailboxes (user_id, via, email, refresh_token, scope, created_at, updated_at)
SELECT user_id, 'gmail', email, refresh_token, scope, created_at, updated_at FROM google_tokens;
DROP TABLE google_tokens;
