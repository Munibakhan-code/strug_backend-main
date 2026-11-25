ALTER TABLE "food_order"
  ADD COLUMN IF NOT EXISTS "seller_handoff_checklist" JSONB;
