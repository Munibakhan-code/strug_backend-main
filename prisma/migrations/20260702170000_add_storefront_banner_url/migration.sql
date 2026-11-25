-- #332: a wide storefront banner photo, distinct from the logo/cover, for food_vendor + store_profile.
ALTER TABLE "food_vendor" ADD COLUMN "banner_url" VARCHAR(1000);
ALTER TABLE "store_profile" ADD COLUMN "banner_url" VARCHAR(1000);
