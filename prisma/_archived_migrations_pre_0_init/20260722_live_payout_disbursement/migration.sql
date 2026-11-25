-- Live-streamer payout disbursement: admin-managed manual payouts + Stripe Connect.
-- Additive only. Safe to apply manually via psql (IF NOT EXISTS guards) on drifted prod.

-- Connect (Express) account for a streamer, populated by the onboarding flow.
-- Null until the streamer connects an account; payouts fall back to manual when null.
ALTER TABLE "live_streamer_profile"
    ADD COLUMN IF NOT EXISTS "stripe_account_id" VARCHAR(80);

-- Disbursement bookkeeping on each payout request.
ALTER TABLE "live_payout_request"
    ADD COLUMN IF NOT EXISTS "stripe_transfer_id" VARCHAR(80);
ALTER TABLE "live_payout_request"
    ADD COLUMN IF NOT EXISTS "paid_at" TIMESTAMP(3);
