-- #492 Friend video-activity discovery rail.
-- Additive + idempotent (prod has migration-drift history; see CLAUDE.md).
ALTER TABLE "social_profile" ADD COLUMN IF NOT EXISTS "share_video_activity" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "social_profile" ADD COLUMN IF NOT EXISTS "show_friend_video_activity" BOOLEAN NOT NULL DEFAULT true;
