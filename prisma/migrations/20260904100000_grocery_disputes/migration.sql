CREATE TABLE IF NOT EXISTS "food_order_dispute" (
  "dispute_id" SERIAL PRIMARY KEY,
  "food_order_id" INTEGER NOT NULL,
  "vendor_id" INTEGER NOT NULL,
  "opened_by_user_id" INTEGER NOT NULL,
  "assigned_user_id" INTEGER,
  "reason" VARCHAR(40) NOT NULL,
  "status" VARCHAR(30) NOT NULL DEFAULT 'open',
  "requested_amount" DOUBLE PRECISION,
  "approved_amount" DOUBLE PRECISION,
  "currency" VARCHAR(10),
  "item_payload" JSONB,
  "evidence" JSONB,
  "seller_response" TEXT,
  "resolution_note" TEXT,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMP(6),
  CONSTRAINT "food_order_dispute_food_order_id_fkey"
    FOREIGN KEY ("food_order_id") REFERENCES "food_order"("food_order_id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "food_order_dispute_vendor_id_fkey"
    FOREIGN KEY ("vendor_id") REFERENCES "food_vendor"("vendor_id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "food_order_dispute_opened_by_user_id_fkey"
    FOREIGN KEY ("opened_by_user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "food_order_dispute_assigned_user_id_fkey"
    FOREIGN KEY ("assigned_user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX IF NOT EXISTS "idx_food_order_dispute_order"
  ON "food_order_dispute"("food_order_id");

CREATE INDEX IF NOT EXISTS "idx_food_order_dispute_vendor_status"
  ON "food_order_dispute"("vendor_id", "status");

CREATE INDEX IF NOT EXISTS "idx_food_order_dispute_reason_status"
  ON "food_order_dispute"("reason", "status");
