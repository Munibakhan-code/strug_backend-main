-- Add created_at to video_analytics and video_likes so channel analytics can
-- bucket views/likes over time. Additive + idempotent; existing rows backfill
-- to the migration timestamp (these tables had no timestamp before).
ALTER TABLE "video_analytics" ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "video_likes" ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
