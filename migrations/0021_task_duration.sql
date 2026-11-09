-- Duration: how many days a task runs, starting on its due date. It only decides when an open task turns overdue:
-- due Nov 1 lasting 2 days is overdue from Nov 3 (shared/rules.ts → lastDay). NULL means 1 day, as before.
ALTER TABLE tasks ADD COLUMN duration_days INTEGER;
