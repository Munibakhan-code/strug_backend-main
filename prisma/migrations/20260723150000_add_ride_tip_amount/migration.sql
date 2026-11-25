-- Rideshare tipping: riders can tip the driver after a trip completes, charged as its own
-- Stripe PaymentIntent and credited 100% to the driver (no platform-fee split, unlike the
-- fare's 79/21 settlement in utils/ride-settlement.js) — mirrors the existing work_job.tip_amount
-- convention (routes/work-job-routes.js).
--
-- Purely additive and idempotent (IF NOT EXISTS), safe to (re-)apply against a prod DB that may
-- carry manual drift.

ALTER TABLE "active_trip" ADD COLUMN IF NOT EXISTS "tip_amount" DOUBLE PRECISION DEFAULT 0;
