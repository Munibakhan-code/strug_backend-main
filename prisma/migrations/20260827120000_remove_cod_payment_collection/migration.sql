-- Remove cash-on-delivery order collection fields. Strug grocery/food delivery
-- now routes through non-cash payment methods only.
DROP INDEX IF EXISTS "idx_food_order_payment_collection";

ALTER TABLE "food_order"
  DROP COLUMN IF EXISTS "payment_collection_status",
  DROP COLUMN IF EXISTS "payment_collected_at",
  DROP COLUMN IF EXISTS "payment_collected_by_driver_id",
  DROP COLUMN IF EXISTS "payment_collection_note";

ALTER TABLE "food_vendor"
  DROP COLUMN IF EXISTS "cod_enabled";
