-- Create video_watch_later table (referenced in schema but never migrated to DB)
CREATE TABLE IF NOT EXISTS "video_watch_later" (
    "id"       SERIAL PRIMARY KEY,
    "video_id" INTEGER NOT NULL,
    "user_id"  INTEGER NOT NULL,
    "saved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "video_watch_later_video_id_fkey" FOREIGN KEY ("video_id") REFERENCES "video"("video_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "video_watch_later_user_id_fkey"  FOREIGN KEY ("user_id")  REFERENCES "user"("user_id")  ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "video_watch_later_user_id_video_id_key"
    ON "video_watch_later"("user_id", "video_id");
