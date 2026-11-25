CREATE TABLE IF NOT EXISTS "dating_crossed_path_event" (
  "dating_crossed_path_event_id" SERIAL PRIMARY KEY,
  "user_id" INTEGER NOT NULL,
  "grid_cell" VARCHAR(32) NOT NULL,
  "time_bucket" TIMESTAMP(6) NOT NULL,
  "area_label" VARCHAR(120),
  "expires_at" TIMESTAMP(6) NOT NULL,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dating_crossed_path_event_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS "dating_crossed_event_user_cell_bucket_unique"
  ON "dating_crossed_path_event"("user_id", "grid_cell", "time_bucket");

CREATE INDEX IF NOT EXISTS "idx_dating_crossed_event_user"
  ON "dating_crossed_path_event"("user_id", "created_at");

CREATE INDEX IF NOT EXISTS "idx_dating_crossed_event_lookup"
  ON "dating_crossed_path_event"("grid_cell", "time_bucket", "expires_at");

CREATE TABLE IF NOT EXISTS "dating_crossed_path_candidate" (
  "dating_crossed_path_candidate_id" SERIAL PRIMARY KEY,
  "user_a_id" INTEGER NOT NULL,
  "user_b_id" INTEGER NOT NULL,
  "grid_cell" VARCHAR(32) NOT NULL,
  "area_label" VARCHAR(120),
  "first_bucket" TIMESTAMP(6) NOT NULL,
  "last_bucket" TIMESTAMP(6) NOT NULL,
  "encounter_count" INTEGER NOT NULL DEFAULT 1,
  "visible_after" TIMESTAMP(6) NOT NULL,
  "expires_at" TIMESTAMP(6) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6),
  CONSTRAINT "dating_crossed_path_candidate_user_a_id_fkey"
    FOREIGN KEY ("user_a_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "dating_crossed_path_candidate_user_b_id_fkey"
    FOREIGN KEY ("user_b_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "dating_crossed_path_candidate_distinct_users_check"
    CHECK ("user_a_id" <> "user_b_id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "dating_crossed_candidate_pair_cell_unique"
  ON "dating_crossed_path_candidate"("user_a_id", "user_b_id", "grid_cell");

CREATE INDEX IF NOT EXISTS "idx_dating_crossed_candidate_a"
  ON "dating_crossed_path_candidate"("user_a_id", "status", "visible_after");

CREATE INDEX IF NOT EXISTS "idx_dating_crossed_candidate_b"
  ON "dating_crossed_path_candidate"("user_b_id", "status", "visible_after");

CREATE INDEX IF NOT EXISTS "idx_dating_crossed_candidate_expiry"
  ON "dating_crossed_path_candidate"("expires_at");
