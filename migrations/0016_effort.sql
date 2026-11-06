-- Effort: a project can track effort on its tasks, in one of a few preset ways (shared/effort.ts), and can make it
-- required before a task is marked done.
--   projects.effort: NULL (not tracked) · 'time' (time spent) · 'tshirt' (XS–XL) · 'fibo' (story points 1–21)
--   tasks.effort:    NULL, or '<type>:<value>' (e.g. 'time:90' for 1h 30m, 'tshirt:M', 'fibo:5'). The type is kept with
--                    the value, so a task moved to another project, or a project that switches type, never misreads
--                    one: a value of another type is kept but not shown or counted.
ALTER TABLE projects ADD COLUMN effort TEXT;
ALTER TABLE projects ADD COLUMN effort_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN effort TEXT;
