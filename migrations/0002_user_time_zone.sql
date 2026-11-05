-- Each person's own time zone (IANA name, e.g. "Asia/Kolkata"), taken from their browser.
-- It decides when "today" starts for them: overdue rollover, "can't be due in the past", and the day a task counts as done.
-- NULL until they next open the app; until then the TEAM_TZ fallback is used.
ALTER TABLE users ADD COLUMN time_zone TEXT;
