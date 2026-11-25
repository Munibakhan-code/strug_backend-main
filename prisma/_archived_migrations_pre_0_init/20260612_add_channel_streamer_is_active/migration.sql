-- Reversible creator channel deactivation.
-- Adds an `is_active` flag to the livestream streamer profile and the video channel.
-- When false: the channel is hidden from public discovery and (for streamers) blocked
-- from going live. Data (VODs, videos, followers, handle) is preserved; the creator can
-- flip it back to true to reactivate. Additive + defaulted, so existing rows stay active.
ALTER TABLE "live_streamer_profile" ADD COLUMN IF NOT EXISTS "is_active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "channel" ADD COLUMN IF NOT EXISTS "is_active" BOOLEAN NOT NULL DEFAULT true;
