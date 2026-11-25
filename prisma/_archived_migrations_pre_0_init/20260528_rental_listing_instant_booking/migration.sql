ALTER TABLE "rental_listing" ADD COLUMN IF NOT EXISTS "instant_booking" BOOLEAN NOT NULL DEFAULT false;
