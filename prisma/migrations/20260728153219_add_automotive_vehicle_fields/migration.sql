-- AlterTable
ALTER TABLE "vehicle" ADD COLUMN     "condition" VARCHAR(50),
ADD COLUMN     "fuel" VARCHAR(50),
ADD COLUMN     "images" JSONB,
ADD COLUMN     "make" VARCHAR(100),
ADD COLUMN     "mileage" INTEGER,
ADD COLUMN     "price" DOUBLE PRECISION,
ADD COLUMN     "transmission" VARCHAR(50),
ADD COLUMN     "video_url" VARCHAR(500);

-- NOTE: 4 unrelated drift indexes (subscription_channel_id_created_at_idx,
-- video_title_idx, video_comments_video_id_created_at_idx,
-- video_likes_video_id_is_like_created_at_idx) were removed from this migration.
-- They are already created by 20260727221232_celebrity; re-creating them here
-- fails with a duplicate-index error on any DB where that migration ran first.
