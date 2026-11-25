ALTER TABLE "food_item"
  ADD COLUMN IF NOT EXISTS "low_stock_threshold" INTEGER;

ALTER TABLE "food_item"
  ADD COLUMN IF NOT EXISTS "expiry_date" DATE;

CREATE INDEX IF NOT EXISTS "idx_food_item_vendor_stock"
  ON "food_item" ("vendor_id", "stock_qty");

CREATE INDEX IF NOT EXISTS "idx_food_item_vendor_expiry"
  ON "food_item" ("vendor_id", "expiry_date");
