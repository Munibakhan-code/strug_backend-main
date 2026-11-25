-- Storefront cover photos (bug board #176 / #177 / #319): providers had no way to add a
-- store cover/banner image. Adds cover_url to the two storefront-owner tables. food_vendor
-- backs food + grocery + catering + floral (distinguished by vendor_type_id), so one column
-- covers all of those verticals; store_profile backs the ecommerce/shop storefront.
-- Additive + idempotent, safe to run on any environment.
ALTER TABLE "food_vendor" ADD COLUMN IF NOT EXISTS "cover_url" VARCHAR(1000);
ALTER TABLE "store_profile" ADD COLUMN IF NOT EXISTS "cover_url" VARCHAR(1000);
