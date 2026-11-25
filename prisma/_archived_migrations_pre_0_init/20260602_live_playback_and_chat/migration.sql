-- Unify live streaming on the modern live_session system.
-- 1) playback_url: HLS URL that browser viewers watch (populated by egress; test stream until real egress lands).
ALTER TABLE "live_session" ADD COLUMN IF NOT EXISTS "playback_url" VARCHAR(500);

-- 2) live_chat_message: persisted live chat keyed by session_id (legacy stream_chat was keyed by the old stream_id).
CREATE TABLE IF NOT EXISTS "live_chat_message" (
    "message_id" SERIAL PRIMARY KEY,
    "session_id" INTEGER NOT NULL,
    "user_id"    INTEGER NOT NULL,
    "username"   VARCHAR(120),
    "text"       VARCHAR(500) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "live_chat_message_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "live_session"("session_id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "live_chat_message_session_id_idx" ON "live_chat_message"("session_id");
