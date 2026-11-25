CREATE TABLE IF NOT EXISTS "food_vendor_closure" (
  "closure_id" SERIAL PRIMARY KEY,
  "vendor_id" INTEGER NOT NULL,
  "starts_at" TIMESTAMP(6) NOT NULL,
  "ends_at" TIMESTAMP(6) NOT NULL,
  "reason" VARCHAR(255),
  "is_active" BOOLEAN DEFAULT true,
  "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6),
  CONSTRAINT "food_vendor_closure_vendor_fkey"
    FOREIGN KEY ("vendor_id") REFERENCES "food_vendor"("vendor_id")
    ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX IF NOT EXISTS "idx_food_vendor_closure_window"
  ON "food_vendor_closure" ("vendor_id", "starts_at", "ends_at");

CREATE INDEX IF NOT EXISTS "idx_food_vendor_closure_active"
  ON "food_vendor_closure" ("vendor_id", "is_active");
