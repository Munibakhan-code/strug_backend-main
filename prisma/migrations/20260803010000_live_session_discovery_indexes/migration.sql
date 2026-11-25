-- Hot paths: discovery by status, streamer active session lookups.
CREATE INDEX IF NOT EXISTS "live_session_status_created_at_idx" ON "live_session"("status", "created_at");
CREATE INDEX IF NOT EXISTS "live_session_streamer_id_status_created_at_idx" ON "live_session"("streamer_id", "status", "created_at");
