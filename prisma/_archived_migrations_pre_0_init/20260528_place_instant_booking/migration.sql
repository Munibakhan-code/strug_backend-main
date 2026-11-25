-- Add instant_booking flag to place model (venues/events).
-- When true, place_orders-routes.js auto-sets order status to 'confirmed' on creation.

ALTER TABLE "place" ADD COLUMN IF NOT EXISTS "instant_booking" BOOLEAN NOT NULL DEFAULT false;
