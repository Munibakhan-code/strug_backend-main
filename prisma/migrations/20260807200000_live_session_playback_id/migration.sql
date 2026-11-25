-- AlterTable
ALTER TABLE "live_session" ADD COLUMN IF NOT EXISTS "playback_id" VARCHAR(100);

-- Do NOT backfill playback_id from stream_key — that would make the public HLS path
-- equal the RTMP publish credential (defeating the indirection). Leave NULL; /init
-- and key-rotate mint a distinct play_* id via mintPlaybackId().

CREATE UNIQUE INDEX IF NOT EXISTS "live_session_playback_id_key" ON "live_session"("playback_id");
