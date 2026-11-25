ALTER TABLE "food_order"
  ADD COLUMN IF NOT EXISTS "delivery_reschedule_request" JSONB;

ALTER TABLE "food_order"
  ADD COLUMN IF NOT EXISTS "driver_wait_compensation" JSONB;
