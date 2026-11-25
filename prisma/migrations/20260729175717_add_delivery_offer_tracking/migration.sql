-- AlterTable
ALTER TABLE "food_order" ADD COLUMN     "declined_driver_ids" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "offer_expires_at" TIMESTAMP(6);

-- AlterTable
ALTER TABLE "product_order" ADD COLUMN     "declined_driver_ids" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "offer_expires_at" TIMESTAMP(6);

-- AlterTable
ALTER TABLE "social_highlight" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- NOTE: 4 unrelated drift indexes (subscription_channel_id_created_at_idx,
-- video_title_idx, video_comments_video_id_created_at_idx,
-- video_likes_video_id_is_like_created_at_idx) were removed from this migration.
-- They are already created by 20260727221232_celebrity; re-creating them here
-- fails with a duplicate-index error on any DB where that migration ran first.
