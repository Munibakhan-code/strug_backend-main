-- Booking-host Stripe Connect payouts: ledger + payout queue + Connect profile.

ALTER TABLE "booking"
  ADD COLUMN IF NOT EXISTS "wallet_credited_at" TIMESTAMP(6);

CREATE TABLE IF NOT EXISTS "booking_host_payout_profile" (
  "user_id" INTEGER NOT NULL,
  "stripe_account_id" VARCHAR(80),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "booking_host_payout_profile_pkey" PRIMARY KEY ("user_id"),
  CONSTRAINT "booking_host_payout_profile_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE TABLE IF NOT EXISTS "booking_host_wallet" (
  "wallet_id" SERIAL PRIMARY KEY,
  "user_id" INTEGER NOT NULL,
  "available_balance" DECIMAL(12,4) NOT NULL DEFAULT 0.00,
  "pending_balance" DECIMAL(12,4) NOT NULL DEFAULT 0.00,
  "total_earned" DECIMAL(12,4) NOT NULL DEFAULT 0.00,
  "currency" TEXT NOT NULL DEFAULT 'CAD',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "booking_host_wallet_user_id_key" UNIQUE ("user_id"),
  CONSTRAINT "booking_host_wallet_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE TABLE IF NOT EXISTS "booking_host_payout_request" (
  "payout_id" SERIAL PRIMARY KEY,
  "user_id" INTEGER NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
  "admin_note" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMP(3),
  "stripe_transfer_id" VARCHAR(80),
  "paid_at" TIMESTAMP(3),
  CONSTRAINT "booking_host_payout_request_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX IF NOT EXISTS "booking_host_payout_request_user_id_idx" ON "booking_host_payout_request"("user_id");
CREATE INDEX IF NOT EXISTS "booking_host_payout_request_status_idx" ON "booking_host_payout_request"("status");
