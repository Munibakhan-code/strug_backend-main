-- Rideshare "schedule for later" was frontend-only theater: the rider's chosen date/time was
-- never persisted and the ride dispatched to a driver immediately regardless, same as booking
-- "now". This adds real persistence for the requested pickup time so a scheduled ride can
-- actually be held (status 'scheduled') until close to that time, plus a reminder dedup flag.
--
-- Purely additive and idempotent (IF NOT EXISTS), safe to (re-)apply against a prod DB that may
-- carry manual drift.

ALTER TABLE "ride_request" ADD COLUMN IF NOT EXISTS "scheduled_at" TIMESTAMP(6);
ALTER TABLE "ride_request" ADD COLUMN IF NOT EXISTS "reminder_sent_at" TIMESTAMP(6);
