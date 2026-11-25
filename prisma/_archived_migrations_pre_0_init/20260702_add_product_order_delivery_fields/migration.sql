-- Local-delivery dispatch for product orders: driver assignment, delivery
-- coordinates/address, and per-order fee breakdown. Also backfills the
-- dg_content.is_international flag (added to the schema for the Books
-- local-vs-international buy toggle). Additive + idempotent so it is safe to
-- replay on prod (Azure migrate-deploy no-ops there; apply via psql).
ALTER TABLE "product_order" ADD COLUMN IF NOT EXISTS "driver_id" INTEGER;
ALTER TABLE "product_order" ADD COLUMN IF NOT EXISTS "delivery_lat" DOUBLE PRECISION;
ALTER TABLE "product_order" ADD COLUMN IF NOT EXISTS "delivery_lng" DOUBLE PRECISION;
ALTER TABLE "product_order" ADD COLUMN IF NOT EXISTS "delivery_address" VARCHAR(1000);
ALTER TABLE "product_order" ADD COLUMN IF NOT EXISTS "delivery_instructions" VARCHAR(1000);
ALTER TABLE "product_order" ADD COLUMN IF NOT EXISTS "delivery_fee" DOUBLE PRECISION DEFAULT 0;
ALTER TABLE "product_order" ADD COLUMN IF NOT EXISTS "platform_fee" DOUBLE PRECISION DEFAULT 0;
ALTER TABLE "product_order" ADD COLUMN IF NOT EXISTS "tax" DOUBLE PRECISION DEFAULT 0;

CREATE INDEX IF NOT EXISTS "idx_product_order_driver" ON "product_order"("driver_id");

ALTER TABLE "dg_content" ADD COLUMN IF NOT EXISTS "is_international" BOOLEAN DEFAULT false;
