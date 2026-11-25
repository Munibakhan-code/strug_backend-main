-- Playlists: user-owned named collections of videos (replaces localStorage-only playlists)
CREATE TABLE IF NOT EXISTS "playlist" (
    "playlist_id" SERIAL PRIMARY KEY,
    "user_id"     INTEGER NOT NULL,
    "name"        VARCHAR(120) NOT NULL,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "playlist_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "playlist_user_id_idx" ON "playlist"("user_id");

CREATE TABLE IF NOT EXISTS "playlist_item" (
    "id"          SERIAL PRIMARY KEY,
    "playlist_id" INTEGER NOT NULL,
    "video_id"    INTEGER NOT NULL,
    "added_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "playlist_item_playlist_id_fkey" FOREIGN KEY ("playlist_id") REFERENCES "playlist"("playlist_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "playlist_item_video_id_fkey"    FOREIGN KEY ("video_id")    REFERENCES "video"("video_id")       ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "playlist_item_playlist_id_video_id_key" ON "playlist_item"("playlist_id", "video_id");
CREATE INDEX IF NOT EXISTS "playlist_item_playlist_id_idx" ON "playlist_item"("playlist_id");
