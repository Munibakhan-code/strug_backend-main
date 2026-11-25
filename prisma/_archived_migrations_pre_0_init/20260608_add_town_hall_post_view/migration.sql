CREATE TABLE IF NOT EXISTS town_hall_post_view (
  id         SERIAL PRIMARY KEY,
  post_id    INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  viewed_at  TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT fk_post FOREIGN KEY(post_id) REFERENCES town_hall_post(post_id) ON DELETE CASCADE,
  CONSTRAINT fk_user FOREIGN KEY(user_id) REFERENCES "user"(user_id) ON DELETE CASCADE,
  UNIQUE (post_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_town_hall_post_view_post
  ON town_hall_post_view (post_id);