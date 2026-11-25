-- Food vendor Stripe Connect payouts: ledger + payout queue + Connect account id.

ALTER TABLE "food_order"
  ADD COLUMN IF NOT EXISTS "wallet_credited_at" TIMESTAMP(6);

ALTER TABLE "food_vendor"
  ADD COLUMN IF NOT EXISTS "stripe_account_id" VARCHAR(80);

CREATE TABLE IF NOT EXISTS "food_vendor_wallet" (
  "wallet_id" SERIAL PRIMARY KEY,
  "vendor_id" INTEGER NOT NULL,
  "user_id" INTEGER NOT NULL,
  "available_balance" DECIMAL(12,4) NOT NULL DEFAULT 0.00,
  "pending_balance" DECIMAL(12,4) NOT NULL DEFAULT 0.00,
  "total_earned" DECIMAL(12,4) NOT NULL DEFAULT 0.00,
  "currency" TEXT NOT NULL DEFAULT 'CAD',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "food_vendor_wallet_vendor_id_key" UNIQUE ("vendor_id"),
  CONSTRAINT "food_vendor_wallet_vendor_id_fkey"
    FOREIGN KEY ("vendor_id") REFERENCES "food_vendor"("vendor_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "food_vendor_wallet_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX IF NOT EXISTS "food_vendor_wallet_user_id_idx" ON "food_vendor_wallet"("user_id");

CREATE TABLE IF NOT EXISTS "food_vendor_payout_request" (
  "payout_id" SERIAL PRIMARY KEY,
  "vendor_id" INTEGER NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
  "admin_note" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMP(3),
  "stripe_transfer_id" VARCHAR(80),
  "paid_at" TIMESTAMP(3),
  CONSTRAINT "food_vendor_payout_request_vendor_id_fkey"
    FOREIGN KEY ("vendor_id") REFERENCES "food_vendor"("vendor_id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "food_vendor_payout_request_vendor_id_idx" ON "food_vendor_payout_request"("vendor_id");
CREATE INDEX IF NOT EXISTS "food_vendor_payout_request_status_idx" ON "food_vendor_payout_request"("status");
