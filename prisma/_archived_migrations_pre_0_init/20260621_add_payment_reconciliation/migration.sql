-- Money-safety: reconcile Stripe charges to their order/donation rows.
-- Additive only (prod has a history of migration drift — see CLAUDE.md). Safe to
-- re-run: every statement is IF NOT EXISTS.

-- 1) Store the Stripe PaymentIntent id on each commerce order + donation so the
--    webhook can flip the row to paid when Stripe confirms the charge.
ALTER TABLE "food_order"    ADD COLUMN IF NOT EXISTS "payment_intent_id" VARCHAR(255);
ALTER TABLE "product_order" ADD COLUMN IF NOT EXISTS "payment_intent_id" VARCHAR(255);
ALTER TABLE "dg_order"      ADD COLUMN IF NOT EXISTS "payment_intent_id" VARCHAR(255);
ALTER TABLE "donations"     ADD COLUMN IF NOT EXISTS "payment_intent_id" VARCHAR(255);
ALTER TABLE "donations"     ADD COLUMN IF NOT EXISTS "payment_status"    VARCHAR(20) DEFAULT 'unpaid';

-- Lookups by intent id happen on every webhook delivery.
CREATE INDEX IF NOT EXISTS "idx_food_order_intent"    ON "food_order"    ("payment_intent_id");
CREATE INDEX IF NOT EXISTS "idx_product_order_intent" ON "product_order" ("payment_intent_id");
CREATE INDEX IF NOT EXISTS "idx_dg_order_intent"      ON "dg_order"      ("payment_intent_id");
CREATE INDEX IF NOT EXISTS "idx_donations_intent"     ON "donations"     ("payment_intent_id");

-- 2) Reconciliation safety net: a charge that succeeded but whose order/donation
--    row was never found (failed persist, or webhook beat the insert).
CREATE TABLE IF NOT EXISTS "stripe_orphan_payment" (
  "orphan_id"         SERIAL PRIMARY KEY,
  "payment_intent_id" VARCHAR(255) NOT NULL UNIQUE,
  "user_id"           INTEGER,
  "amount"            DOUBLE PRECISION,
  "currency"          VARCHAR(10),
  "purpose"           VARCHAR(40),
  "vertical"          VARCHAR(40),
  "status"            VARCHAR(20) NOT NULL DEFAULT 'unreconciled',
  "created_at"        TIMESTAMP(6) DEFAULT now()
);
