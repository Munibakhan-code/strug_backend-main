-- Idempotency key for wallet ledger rows tied to an external event (e.g. a Stripe
-- PaymentIntent for a wallet top-up). The UNIQUE index lets a single charge be credited at
-- most once even under concurrent confirm requests (PAY-2: the old findFirst dedupe had a
-- TOCTOU window). Additive + idempotent. NULL allowed and not deduped (Postgres permits
-- multiple NULLs in a unique index), so all existing rows (external_ref NULL) are unaffected.
ALTER TABLE "wallet_transaction" ADD COLUMN IF NOT EXISTS "external_ref" VARCHAR;
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_transaction_external_ref_key"
  ON "wallet_transaction" ("external_ref");
