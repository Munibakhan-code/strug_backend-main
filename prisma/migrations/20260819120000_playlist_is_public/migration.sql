ALTER TABLE "playlist" ADD COLUMN IF NOT EXISTS "is_public" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "idx_playlist_user_public" ON "playlist"("user_id", "is_public");
