ALTER TABLE "food_order"
  ADD COLUMN IF NOT EXISTS "delivery_offer_events" JSONB;
