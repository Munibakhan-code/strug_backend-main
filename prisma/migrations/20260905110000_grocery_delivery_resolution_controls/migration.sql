ALTER TABLE "food_order"
  ADD COLUMN IF NOT EXISTS "delivery_preference" JSONB,
  ADD COLUMN IF NOT EXISTS "delivery_delay_reason" JSONB,
  ADD COLUMN IF NOT EXISTS "delivery_failure_resolution" JSONB,
  ADD COLUMN IF NOT EXISTS "delivery_proof_requirements" JSONB;
