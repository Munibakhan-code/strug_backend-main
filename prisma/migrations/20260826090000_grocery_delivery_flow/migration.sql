ALTER TABLE "food_order"
  ADD COLUMN IF NOT EXISTS "order_flow" VARCHAR(30),
  ADD COLUMN IF NOT EXISTS "delivery_window_start" TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "delivery_window_end" TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "store_accepted_at" TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "packed_at" TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "ready_for_pickup_at" TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "driver_accepted_at" TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "driver_en_route_at" TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "picked_up_at" TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "delivery_proof" JSONB,
  ADD COLUMN IF NOT EXISTS "delivery_proof_at" TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "driver_earning" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "grocery_substitutions" JSONB;

CREATE INDEX IF NOT EXISTS "idx_food_order_flow_status"
  ON "food_order"("order_flow", "order_status");
