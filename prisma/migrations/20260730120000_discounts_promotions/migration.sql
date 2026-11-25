ALTER TABLE "product_variation"
  ADD COLUMN IF NOT EXISTS "discount_starts_at" TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "discount_ends_at" TIMESTAMP(6);

CREATE INDEX IF NOT EXISTS "idx_product_variation_discount_pct" ON "product_variation"("discount_pct");

ALTER TABLE "product_order"
  ADD COLUMN IF NOT EXISTS "promo_code" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "promo_discount" DOUBLE PRECISION DEFAULT 0;

ALTER TABLE "food_order"
  ADD COLUMN IF NOT EXISTS "promo_code" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "promo_discount" DOUBLE PRECISION DEFAULT 0;

CREATE TABLE IF NOT EXISTS "promotion" (
  "promotion_id" SERIAL PRIMARY KEY,
  "code" VARCHAR(64) NOT NULL,
  "title" VARCHAR(255),
  "description" TEXT,
  "kind" VARCHAR(30) NOT NULL DEFAULT 'coupon',
  "discount_type" VARCHAR(20) NOT NULL,
  "discount_value" DOUBLE PRECISION NOT NULL,
  "owner_user_id" INTEGER,
  "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
  "starts_at" TIMESTAMP(6),
  "ends_at" TIMESTAMP(6),
  "max_redemptions" INTEGER,
  "per_user_limit" INTEGER DEFAULT 1,
  "min_order_amount" DOUBLE PRECISION DEFAULT 0,
  "quantity_limit" INTEGER,
  "claimed_count" INTEGER NOT NULL DEFAULT 0,
  "scope" VARCHAR(40) DEFAULT 'platform',
  "vertical" VARCHAR(40),
  "category" VARCHAR(80),
  "geo_city" VARCHAR(120),
  "is_featured" BOOLEAN NOT NULL DEFAULT false,
  "report_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "promotion_code_key" UNIQUE ("code"),
  CONSTRAINT "promotion_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX IF NOT EXISTS "idx_promotion_status_window" ON "promotion"("status", "starts_at", "ends_at");
CREATE INDEX IF NOT EXISTS "idx_promotion_owner" ON "promotion"("owner_user_id");
CREATE INDEX IF NOT EXISTS "idx_promotion_kind_status" ON "promotion"("kind", "status");

CREATE TABLE IF NOT EXISTS "promotion_redemption" (
  "redemption_id" SERIAL PRIMARY KEY,
  "promotion_id" INTEGER NOT NULL,
  "user_id" INTEGER NOT NULL,
  "order_id" INTEGER,
  "order_ref" VARCHAR(80),
  "amount" DOUBLE PRECISION NOT NULL,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "promotion_redemption_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "promotion"("promotion_id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "promotion_redemption_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "promotion_redemption_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "product_order"("order_id") ON DELETE SET NULL ON UPDATE NO ACTION
);

CREATE INDEX IF NOT EXISTS "idx_promotion_redemption_promo" ON "promotion_redemption"("promotion_id");
CREATE INDEX IF NOT EXISTS "idx_promotion_redemption_user" ON "promotion_redemption"("user_id");
CREATE INDEX IF NOT EXISTS "idx_promotion_redemption_order" ON "promotion_redemption"("order_id");

CREATE TABLE IF NOT EXISTS "discount_report" (
  "report_id" SERIAL PRIMARY KEY,
  "reporter_id" INTEGER,
  "promotion_id" INTEGER,
  "listing_id" INTEGER,
  "reason" TEXT,
  "status" VARCHAR(30) NOT NULL DEFAULT 'open',
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "discount_report_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "discount_report_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "promotion"("promotion_id") ON DELETE SET NULL ON UPDATE NO ACTION
);

CREATE INDEX IF NOT EXISTS "idx_discount_report_status" ON "discount_report"("status");
CREATE INDEX IF NOT EXISTS "idx_discount_report_promo" ON "discount_report"("promotion_id");

-- Seed platform starter coupons so validate has real DB-backed codes (replaces hardcoded map).
INSERT INTO "promotion" ("code", "title", "description", "kind", "discount_type", "discount_value", "status", "starts_at", "max_redemptions", "per_user_limit", "scope")
VALUES
  ('STRUG10', '10% off', '10% off your order', 'coupon', 'percent', 10, 'active', NOW(), NULL, 5, 'platform'),
  ('SAVE5', '$5 off', '$5 off your order', 'coupon', 'fixed', 5, 'active', NOW(), NULL, 5, 'platform'),
  ('WELCOME15', '15% off', '15% off your order', 'coupon', 'percent', 15, 'active', NOW(), NULL, 1, 'platform'),
  ('STRUGNOW', '$3 off', '$3 off your order', 'coupon', 'fixed', 3, 'active', NOW(), NULL, 5, 'platform')
ON CONFLICT ("code") DO NOTHING;
