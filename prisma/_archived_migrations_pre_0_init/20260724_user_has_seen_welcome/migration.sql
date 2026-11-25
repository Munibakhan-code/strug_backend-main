-- Per-account "has seen the Welcome modal" flag.
--
-- The Welcome hub was previously gated only by per-device localStorage
-- ('strug_welcome_seen'), which meant it (a) showed to every EXISTING user once per
-- device (bug #95) and (b) re-showed on every new device / browser (bug #98). Moving the
-- flag server-side keys it to the account instead: it shows exactly once per account, on
-- any device, and only to genuinely new accounts.
--
-- Backfill: every account that exists at migration time is treated as already-onboarded
-- (true) so the welcome never pops for them. Only accounts created AFTER this migration
-- default to false and therefore see it once.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "has_seen_welcome" BOOLEAN NOT NULL DEFAULT false;
UPDATE "user" SET "has_seen_welcome" = true WHERE "has_seen_welcome" = false;
