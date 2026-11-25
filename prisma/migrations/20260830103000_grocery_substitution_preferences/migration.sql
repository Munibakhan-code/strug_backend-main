ALTER TABLE "food_order"
  ADD COLUMN IF NOT EXISTS "substitution_preference" JSONB;
