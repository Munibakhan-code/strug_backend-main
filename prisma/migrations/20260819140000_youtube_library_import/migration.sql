-- Copy a creator's YouTube library onto Strug (Creator Studio import).
ALTER TABLE "video" ADD COLUMN IF NOT EXISTS "youtube_id" VARCHAR(32);

CREATE UNIQUE INDEX IF NOT EXISTS "video_youtube_id_key" ON "video"("youtube_id");

CREATE TABLE IF NOT EXISTS "youtube_import_job" (
    "job_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "channel_id" INTEGER NOT NULL,
    "source_url" VARCHAR(500) NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'queued',
    "total_found" INTEGER NOT NULL DEFAULT 0,
    "imported_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "error_message" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "youtube_import_job_pkey" PRIMARY KEY ("job_id")
);

CREATE TABLE IF NOT EXISTS "youtube_import_item" (
    "item_id" SERIAL NOT NULL,
    "job_id" INTEGER NOT NULL,
    "youtube_id" VARCHAR(32) NOT NULL,
    "title" VARCHAR(255),
    "status" VARCHAR(24) NOT NULL DEFAULT 'queued',
    "video_id" INTEGER,
    "error_message" VARCHAR(500),
    CONSTRAINT "youtube_import_item_pkey" PRIMARY KEY ("item_id")
);

CREATE INDEX IF NOT EXISTS "youtube_import_job_user_id_created_at_idx" ON "youtube_import_job"("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "youtube_import_job_channel_id_status_idx" ON "youtube_import_job"("channel_id", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "youtube_import_item_job_id_youtube_id_key" ON "youtube_import_item"("job_id", "youtube_id");
CREATE INDEX IF NOT EXISTS "youtube_import_item_youtube_id_idx" ON "youtube_import_item"("youtube_id");

ALTER TABLE "youtube_import_job" DROP CONSTRAINT IF EXISTS "youtube_import_job_channel_id_fkey";
ALTER TABLE "youtube_import_job" ADD CONSTRAINT "youtube_import_job_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channel"("channel_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "youtube_import_item" DROP CONSTRAINT IF EXISTS "youtube_import_item_job_id_fkey";
ALTER TABLE "youtube_import_item" ADD CONSTRAINT "youtube_import_item_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "youtube_import_job"("job_id") ON DELETE CASCADE ON UPDATE CASCADE;
