-- Dependencies: a task can wait on other tasks (its blockers), and a task can block several others.
--   • One row per link: task_id waits on blocker_id. Both are tasks on this instance; no cycles (worker/dependencies.ts).
--   • A blocker stops blocking once it's done (or archived). Adding and removing a link is logged in task_events on
--     both tasks: blocker_added / blocker_removed on the waiting task, dependent_added / dependent_removed on the
--     blocker (to_value = the other task's id).
--   • Removing a link deletes its row, like unfollowing; the history keeps the record.
CREATE TABLE task_dependencies (
  task_id    TEXT NOT NULL REFERENCES tasks (id),
  blocker_id TEXT NOT NULL REFERENCES tasks (id),
  added_by   TEXT NOT NULL REFERENCES users (id),
  at         TEXT NOT NULL,
  PRIMARY KEY (task_id, blocker_id),
  CHECK (task_id != blocker_id)
);
CREATE INDEX task_dependencies_blocker ON task_dependencies (blocker_id);
