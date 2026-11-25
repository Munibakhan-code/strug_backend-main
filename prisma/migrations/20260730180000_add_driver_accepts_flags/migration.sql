-- AlterTable: per-vertical opt-in preferences on the shared driver identity.
-- accepts_rides defaults true so every existing driver_profile row (which already implicitly
-- means "rideshare-capable") keeps matching exactly as it does today.
ALTER TABLE "driver_profile" ADD COLUMN "accepts_rides" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "driver_profile" ADD COLUMN "accepts_food" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "driver_profile" ADD COLUMN "accepts_product" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "driver_profile" ADD COLUMN "accepts_courier" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: capability-row existence already means "opted in" today — seed the new flags so
-- drivers who already completed food/product/courier registration aren't silently opted out.
UPDATE "driver_profile"
SET "accepts_food" = true, "accepts_product" = true
FROM "driver_delivery_profile"
WHERE "driver_delivery_profile"."driver_profile_id" = "driver_profile"."driver_profile_id";

UPDATE "driver_profile"
SET "accepts_courier" = true
FROM "driver_courier_profile"
WHERE "driver_courier_profile"."driver_profile_id" = "driver_profile"."driver_profile_id";

-- AlterTable: driver_delivery_profile no longer carries its own presence — driver_profile is
-- now the single source of online/offline + location for every vertical. Safe to drop outright:
-- no frontend caller has ever set driver_delivery_profile.is_online, so there is no live state.
ALTER TABLE "driver_delivery_profile" DROP COLUMN "is_online";
ALTER TABLE "driver_delivery_profile" DROP COLUMN "current_lat";
ALTER TABLE "driver_delivery_profile" DROP COLUMN "current_long";
