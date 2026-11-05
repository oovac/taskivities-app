-- App settings that admins edit in the app (Settings page). One row per setting.
-- logo: the uploaded SVG logo (header + browser tab icon). An empty value means the built-in logo.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by TEXT REFERENCES users (id),
  updated_at TEXT NOT NULL
);
