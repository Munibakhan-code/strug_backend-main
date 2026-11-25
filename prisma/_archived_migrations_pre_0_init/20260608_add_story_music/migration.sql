-- Story background music (uploaded audio attached to a story).
-- Additive + idempotent (IF NOT EXISTS) so it's safe against drifted environments.

ALTER TABLE "social_story" ADD COLUMN IF NOT EXISTS "music_url" TEXT;
ALTER TABLE "social_story" ADD COLUMN IF NOT EXISTS "music_title" VARCHAR(255);
