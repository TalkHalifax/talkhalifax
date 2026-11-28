-- Story likes: one row per reader per story. A reader likes a story once and can take it back.
-- D1 enforces foreign keys, so deleting a story or an account removes its likes. A migration that rebuilds stories or
-- users with DROP TABLE would delete every like the same way: copy story_likes aside first.
CREATE TABLE story_likes (
  story_id   TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,           -- ms, as the app keeps times
  PRIMARY KEY (story_id, user_id)
);
-- A reader's likes, for removing them with the account (Trust & Safety)
CREATE INDEX story_likes_user ON story_likes(user_id);
