-- AlterTable
ALTER TABLE "driver_profile" ADD COLUMN     "accept_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "decline_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "prev_lat" DOUBLE PRECISION,
ADD COLUMN     "prev_long" DOUBLE PRECISION,
ADD COLUMN     "prev_ping_at" TIMESTAMP(6);
