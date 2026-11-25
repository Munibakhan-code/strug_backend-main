-- Town Hall X/Twitter library import (mirrors Creator Studio YouTube import).
ALTER TABLE "town_hall_post"
  ADD COLUMN IF NOT EXISTS "external_source" VARCHAR(24),
  ADD COLUMN IF NOT EXISTS "external_id" VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS "town_hall_post_external_source_external_id_key"
  ON "town_hall_post" ("external_source", "external_id");

CREATE TABLE IF NOT EXISTS "townhall_import_job" (
  "job_id" SERIAL PRIMARY KEY,
  "user_id" INTEGER NOT NULL,
  "source_url" VARCHAR(500) NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'queued',
  "total_found" INTEGER NOT NULL DEFAULT 0,
  "imported_count" INTEGER NOT NULL DEFAULT 0,
  "skipped_count" INTEGER NOT NULL DEFAULT 0,
  "failed_count" INTEGER NOT NULL DEFAULT 0,
  "error_message" VARCHAR(500),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "townhall_import_job_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "townhall_import_job_user_id_created_at_idx"
  ON "townhall_import_job" ("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "townhall_import_job_user_id_status_idx"
  ON "townhall_import_job" ("user_id", "status");

CREATE TABLE IF NOT EXISTS "townhall_import_item" (
  "item_id" SERIAL PRIMARY KEY,
  "job_id" INTEGER NOT NULL,
  "external_id" VARCHAR(64) NOT NULL,
  "title" VARCHAR(280),
  "status" VARCHAR(24) NOT NULL DEFAULT 'queued',
  "post_id" INTEGER,
  "error_message" VARCHAR(500),
  CONSTRAINT "townhall_import_item_job_id_fkey"
    FOREIGN KEY ("job_id") REFERENCES "townhall_import_job"("job_id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "townhall_import_item_job_id_external_id_key"
  ON "townhall_import_item" ("job_id", "external_id");
CREATE INDEX IF NOT EXISTS "townhall_import_item_external_id_idx"
  ON "townhall_import_item" ("external_id");
