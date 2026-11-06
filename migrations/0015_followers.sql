-- Following a task: followers hear about its comments, when it's done or reopened, and when it's handed to someone
-- (notifications and the inbox), as whoever has the task always does.
--   • The task's creator follows it without a row here, unless they stop: then a row with following = 0.
--     (So every way a task is made, from the app, assistants, webhooks or repeats, gets this without extra writes.)
--   • Anyone else follows with a row with following = 1: by following it themselves, by being added by someone on the
--     project, or by commenting on it.
-- Unfollowing deletes the row (or, for the creator, sets following = 0).
CREATE TABLE task_followers (
  task_id    TEXT NOT NULL REFERENCES tasks (id),
  user_id    TEXT NOT NULL REFERENCES users (id),
  following  INTEGER NOT NULL DEFAULT 1,
  added_by   TEXT REFERENCES users (id),
  at         TEXT NOT NULL,
  PRIMARY KEY (task_id, user_id)
);
CREATE INDEX task_followers_user ON task_followers (user_id, following);

-- The inbox: someone else added you as a follower, and a task of yours was handed to someone else.
CREATE INDEX task_events_follower_added ON task_events (to_value, at) WHERE type = 'follower_added';
CREATE INDEX task_events_transferred_from ON task_events (from_value, at) WHERE type = 'transferred';
