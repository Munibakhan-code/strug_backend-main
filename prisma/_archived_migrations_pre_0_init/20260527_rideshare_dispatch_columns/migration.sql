-- AlterTable
ALTER TABLE "ride_request" ADD COLUMN IF NOT EXISTS "assigned_driver_id" INTEGER,
                           ADD COLUMN IF NOT EXISTS "offer_expires_at" TIMESTAMP(6),
                           ADD COLUMN IF NOT EXISTS "offered_fare" DOUBLE PRECISION,
                           ADD COLUMN IF NOT EXISTS "estimated_fare" DOUBLE PRECISION;
