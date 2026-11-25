-- Enforce one donation row per Stripe PaymentIntent — DB-level replay guard for PAY-1
-- (the app-level findFirst check in donation-routes.js has a TOCTOU window under concurrency).
--
-- Additive + idempotent (prod has migration drift — see CLAUDE.md). NULLs are allowed and
-- intentionally NOT deduped: unpaid donations carry no payment_intent_id, and Postgres permits
-- multiple NULLs in a unique index.
--
-- PRECONDITION: there must be NO existing duplicate non-null payment_intent_id rows, or the
-- CREATE UNIQUE INDEX will fail. Verify before applying:
--   SELECT payment_intent_id, COUNT(*) FROM donations
--   WHERE payment_intent_id IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1;
-- If that returns rows, resolve the duplicates (they indicate prior PAY-1 abuse or a
-- reconciliation bug) before running this migration — do NOT blindly null them out.

-- Replace the existing non-unique index with a unique one.
DROP INDEX IF EXISTS "idx_donations_intent";
CREATE UNIQUE INDEX IF NOT EXISTS "donations_payment_intent_id_key"
  ON "donations" ("payment_intent_id");
