-- Rideshare settlement audit fields (Phase 5 / Task 6)
ALTER TABLE "active_trip" ADD COLUMN IF NOT EXISTS "driver_payout" DOUBLE PRECISION;
ALTER TABLE "active_trip" ADD COLUMN IF NOT EXISTS "platform_fee" DOUBLE PRECISION;
