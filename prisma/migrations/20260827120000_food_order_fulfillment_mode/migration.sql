-- Create-time fulfillment mode so pickup vs courier is not inferred from a
-- customer-writable deliver_location. Default delivery matches legacy rows.
ALTER TABLE "food_order" ADD COLUMN "fulfillment_mode" VARCHAR(20) NOT NULL DEFAULT 'delivery';

-- Existing self-pickup rows: explicit sentinel, plus the pre-sentinel heuristic
-- (empty address + zero fee + no courier).
UPDATE "food_order"
SET "fulfillment_mode" = 'pickup'
WHERE TRIM(BOTH FROM COALESCE("deliver_location", '')) = '__SELF_PICKUP__'
   OR (
     TRIM(BOTH FROM COALESCE("deliver_location", '')) = ''
     AND COALESCE("delivery_fee", 0) = 0
     AND "driver_id" IS NULL
   );

CREATE INDEX "idx_food_order_fulfillment" ON "food_order"("fulfillment_mode");
