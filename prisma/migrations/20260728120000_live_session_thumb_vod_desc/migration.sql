-- Live session poster thumbnail + VOD description for YouTube-style metadata.
ALTER TABLE "live_session" ADD COLUMN IF NOT EXISTS "thumbnail_url" VARCHAR(500);
ALTER TABLE "live_vod" ADD COLUMN IF NOT EXISTS "description" TEXT;
