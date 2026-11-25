-- AlterTable
ALTER TABLE "food_order" ADD COLUMN IF NOT EXISTS "referral_code" VARCHAR(80);

-- AlterTable
ALTER TABLE "product_order" ADD COLUMN IF NOT EXISTS "referral_code" VARCHAR(80);

-- AlterTable
ALTER TABLE "ride_request" ADD COLUMN IF NOT EXISTS "referral_code" VARCHAR(80);
