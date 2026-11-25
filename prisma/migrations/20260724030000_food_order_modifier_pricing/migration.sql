ALTER TABLE "food_order" ADD COLUMN IF NOT EXISTS "tip_amount" DOUBLE PRECISION DEFAULT 0;
ALTER TABLE "food_order_items" ADD COLUMN IF NOT EXISTS "modifier_option_ids" JSONB;
