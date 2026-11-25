-- Dedup table for live VOD/clip views (mirrors video_view).
CREATE TABLE IF NOT EXISTS "live_vod_view" (
    "id" SERIAL NOT NULL,
    "vod_id" INTEGER NOT NULL,
    "identifier" VARCHAR(80) NOT NULL,
    "viewed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_vod_view_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "live_vod_view_vod_id_identifier_key" ON "live_vod_view"("vod_id", "identifier");
CREATE INDEX IF NOT EXISTS "live_vod_view_vod_id_idx" ON "live_vod_view"("vod_id");

DO $$ BEGIN
  ALTER TABLE "live_vod_view"
    ADD CONSTRAINT "live_vod_view_vod_id_fkey"
    FOREIGN KEY ("vod_id") REFERENCES "live_vod"("vod_id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
