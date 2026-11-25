-- Private profiles need follow requests that do not grant feed access until accepted (#1189).
ALTER TABLE "follower" ADD COLUMN IF NOT EXISTS "status" VARCHAR(20) NOT NULL DEFAULT 'accepted';

CREATE INDEX IF NOT EXISTS "follower_following_id_status_idx" ON "follower"("following_id", "status");
