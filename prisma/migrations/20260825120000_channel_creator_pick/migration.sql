-- Creator's Choice: a channel recommends another creator's video or channel to subscribers.
-- Additive. Table/indexes use IF NOT EXISTS; FKs drop-then-add so re-apply is safe.
CREATE TABLE IF NOT EXISTS "channel_creator_pick" (
    "pick_id" SERIAL NOT NULL,
    "channel_id" INTEGER NOT NULL,
    "pick_type" VARCHAR(16) NOT NULL,
    "video_id" INTEGER,
    "target_channel_id" INTEGER,
    "note" VARCHAR(200),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_creator_pick_pkey" PRIMARY KEY ("pick_id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "channel_creator_pick_channel_id_video_id_key"
    ON "channel_creator_pick"("channel_id", "video_id")
    WHERE "video_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "channel_creator_pick_channel_id_target_channel_id_key"
    ON "channel_creator_pick"("channel_id", "target_channel_id")
    WHERE "target_channel_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "channel_creator_pick_channel_id_sort_order_created_at_idx"
    ON "channel_creator_pick"("channel_id", "sort_order", "created_at");

CREATE INDEX IF NOT EXISTS "channel_creator_pick_created_at_idx"
    ON "channel_creator_pick"("created_at");

ALTER TABLE "channel_creator_pick" DROP CONSTRAINT IF EXISTS "channel_creator_pick_channel_id_fkey";
ALTER TABLE "channel_creator_pick" ADD CONSTRAINT "channel_creator_pick_channel_id_fkey"
    FOREIGN KEY ("channel_id") REFERENCES "channel"("channel_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "channel_creator_pick" DROP CONSTRAINT IF EXISTS "channel_creator_pick_video_id_fkey";
ALTER TABLE "channel_creator_pick" ADD CONSTRAINT "channel_creator_pick_video_id_fkey"
    FOREIGN KEY ("video_id") REFERENCES "video"("video_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "channel_creator_pick" DROP CONSTRAINT IF EXISTS "channel_creator_pick_target_channel_id_fkey";
ALTER TABLE "channel_creator_pick" ADD CONSTRAINT "channel_creator_pick_target_channel_id_fkey"
    FOREIGN KEY ("target_channel_id") REFERENCES "channel"("channel_id") ON DELETE CASCADE ON UPDATE CASCADE;
