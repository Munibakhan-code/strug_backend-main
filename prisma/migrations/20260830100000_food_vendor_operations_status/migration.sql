ALTER TABLE "food_vendor"
  ADD COLUMN IF NOT EXISTS "operations_status" VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "operations_note" TEXT;
