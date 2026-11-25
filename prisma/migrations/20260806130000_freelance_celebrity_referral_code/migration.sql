-- AlterTable
ALTER TABLE "FreelancerOrder" ADD COLUMN IF NOT EXISTS "referral_code" VARCHAR(80);

-- AlterTable
ALTER TABLE "CelebrityBooking" ADD COLUMN IF NOT EXISTS "referral_code" VARCHAR(80);
