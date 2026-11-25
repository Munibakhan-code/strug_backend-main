-- Raise deep crowdfunding: reward tiers, campaign updates, and creator payouts.
-- Additive only (prod has a history of migration drift — see CLAUDE.md). Safe to
-- re-run: every statement is IF NOT EXISTS.

-- 1) Backer-selectable pledge tiers for a campaign.
CREATE TABLE IF NOT EXISTS "reward_tier" (
  "tier_id"            SERIAL PRIMARY KEY,
  "project_id"         INTEGER NOT NULL REFERENCES "projects" ("project_id") ON DELETE CASCADE,
  "title"              VARCHAR(255),
  "description"        TEXT,
  "amount"            DOUBLE PRECISION NOT NULL,
  "reward_description" TEXT,
  "quantity_limit"     INTEGER,
  "claimed_count"      INTEGER NOT NULL DEFAULT 0,
  "sort_order"         INTEGER NOT NULL DEFAULT 0,
  "created_at"         TIMESTAMP(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_reward_tier_project" ON "reward_tier" ("project_id");

-- A donation may reference the pledge tier the backer chose.
ALTER TABLE "donations" ADD COLUMN IF NOT EXISTS "reward_tier_id" INTEGER;

-- 2) Creator-authored progress updates shown to backers.
CREATE TABLE IF NOT EXISTS "campaign_update" (
  "update_id"  SERIAL PRIMARY KEY,
  "project_id" INTEGER NOT NULL REFERENCES "projects" ("project_id") ON DELETE CASCADE,
  "title"      VARCHAR(255),
  "body"       TEXT,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_campaign_update_project" ON "campaign_update" ("project_id");

-- 3) Ledger of creator withdrawals (net of platform fee) to the wallet.
CREATE TABLE IF NOT EXISTS "campaign_payout" (
  "payout_id"     SERIAL PRIMARY KEY,
  "project_id"    INTEGER NOT NULL REFERENCES "projects" ("project_id") ON DELETE CASCADE,
  "owner_user_id" INTEGER NOT NULL,
  "gross_amount"  DOUBLE PRECISION NOT NULL,
  "fee_amount"    DOUBLE PRECISION NOT NULL,
  "net_amount"    DOUBLE PRECISION NOT NULL,
  "status"        VARCHAR(20) NOT NULL DEFAULT 'completed',
  "created_at"    TIMESTAMP(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_campaign_payout_project" ON "campaign_payout" ("project_id");
