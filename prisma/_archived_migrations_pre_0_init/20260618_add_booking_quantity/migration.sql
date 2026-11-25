-- Booking engine: per-booking quantity multiplier (event tickets, per-person
-- sessions, rented items). Additive + idempotent; defaults to 1 so existing
-- bookings and date-range verticals are unaffected.
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "quantity" INTEGER DEFAULT 1;
