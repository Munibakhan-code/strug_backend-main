-- Durable per-viewer view dedup (Redis-independent). See model video_view.
CREATE TABLE IF NOT EXISTS "video_view" (
    "id" SERIAL NOT NULL,
    "video_id" INTEGER NOT NULL,
    "identifier" VARCHAR(80) NOT NULL,
    "viewed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "video_view_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "video_view_video_id_identifier_key" ON "video_view"("video_id", "identifier");
CREATE INDEX IF NOT EXISTS "video_view_video_id_idx" ON "video_view"("video_id");
