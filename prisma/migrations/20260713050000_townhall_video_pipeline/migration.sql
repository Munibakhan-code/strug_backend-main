-- #415: give town hall posts the same video pipeline columns the `video` model has.
--
-- Town hall posts play the ORIGINAL upload. The backend stores the raw file untouched — no
-- transcode, no HLS rendition, no thumbnail, up to 50MB — so a feed video is slow to start,
-- cannot adapt bitrate, and has no poster frame to show while it buffers. (Images ARE optimised
-- on upload; video is passed straight through.) These columns let the SAME strug_worker pipeline
-- process a town hall post and write its results back.
--
-- Deliberately NULLABLE with no default. An existing post keeps processing_status NULL, which the
-- client reads as "no rendition — play media_url", i.e. exactly today's behaviour. A NOT NULL
-- DEFAULT 'pending' would instead make every pre-existing video post look permanently stuck.
ALTER TABLE "town_hall_post" ADD COLUMN IF NOT EXISTS "hls_url"             TEXT;
ALTER TABLE "town_hall_post" ADD COLUMN IF NOT EXISTS "thumbnail_url"       TEXT;
ALTER TABLE "town_hall_post" ADD COLUMN IF NOT EXISTS "duration_sec"        INTEGER;
ALTER TABLE "town_hall_post" ADD COLUMN IF NOT EXISTS "processing_status"   VARCHAR(20);
ALTER TABLE "town_hall_post" ADD COLUMN IF NOT EXISTS "processing_error"    VARCHAR(500);
ALTER TABLE "town_hall_post" ADD COLUMN IF NOT EXISTS "processing_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "town_hall_post" ADD COLUMN IF NOT EXISTS "last_attempt_at"     TIMESTAMP(3);

-- The reconciliation sweep looks for posts that are mid-flight or never finished.
CREATE INDEX IF NOT EXISTS "town_hall_post_processing_status_idx"
    ON "town_hall_post" ("processing_status");
