-- Files from Google Drive and OneDrive / SharePoint (worker/cloud-files.ts).
-- A copy is an ordinary attachment in R2. A link has no bytes here: key is '' and url is the file's address at the
-- provider, where its own sharing decides who can open it. provider is 'google' or 'microsoft' for both kinds.
ALTER TABLE attachments ADD COLUMN url TEXT;
ALTER TABLE attachments ADD COLUMN provider TEXT;
