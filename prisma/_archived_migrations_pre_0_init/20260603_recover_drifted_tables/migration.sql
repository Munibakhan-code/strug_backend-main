-- RECOVERY: prod had 20260602_add_playlists / 20260602_add_user_addresses /
-- 20260603_create_user_address_table marked-applied in _prisma_migrations but their
-- SQL never ran (advisory-lock drift), so the tables are missing on prod while
-- migrate deploy reports "no pending". This pending migration recreates them
-- idempotently — a no-op anywhere the tables already exist (e.g. staging).

-- Playlists
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

-- Multi-address book
CREATE TABLE IF NOT EXISTS "user_address" (
    "address_id" SERIAL PRIMARY KEY,
    "user_id"    INTEGER NOT NULL,
    "label"      VARCHAR(60) NOT NULL,
    "street"     VARCHAR(255) NOT NULL,
    "city"       VARCHAR(120),
    "country"    VARCHAR(120),
    "lat"        DOUBLE PRECISION,
    "lng"        DOUBLE PRECISION,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_address_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "user_address_user_id_idx" ON "user_address"("user_id");
