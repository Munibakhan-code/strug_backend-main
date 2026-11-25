-- Platform launches single-currency in CAD. Default every currency column to CAD,
-- and FX-convert existing LKR balances at the in-code rate (LKR:300, CAD:1.35 per USD,
-- i.e. 1 LKR = 1.35/300 CAD). Relabeling without converting would mis-value real balances.

-- Defaults --------------------------------------------------------------------
ALTER TABLE "strug_wallet"         ALTER COLUMN "currency" SET DEFAULT 'CAD';
ALTER TABLE "live_streamer_wallet" ALTER COLUMN "currency" SET DEFAULT 'CAD';
ALTER TABLE "ads_wallet"           ALTER COLUMN "currency" SET DEFAULT 'CAD';
ALTER TABLE "ads_account_profile"  ALTER COLUMN "currency" SET DEFAULT 'CAD';
ALTER TABLE "user"                 ALTER COLUMN "currency" SET DEFAULT 'CAD';

-- FX-convert existing LKR wallet balances to CAD --------------------------------
UPDATE "strug_wallet"         SET "balance" = ROUND("balance" / 300.0 * 1.35, 2), "currency" = 'CAD' WHERE "currency" = 'LKR';
UPDATE "live_streamer_wallet" SET "balance" = ROUND("balance" / 300.0 * 1.35, 4), "currency" = 'CAD' WHERE "currency" = 'LKR';
UPDATE "ads_wallet"           SET "balance" = ROUND("balance" / 300.0 * 1.35, 4), "currency" = 'CAD' WHERE "currency" = 'LKR';

-- Account profiles carry no balance — relabel only.
UPDATE "ads_account_profile" SET "currency" = 'CAD' WHERE "currency" = 'LKR';

-- All users operate in CAD.
UPDATE "user" SET "currency" = 'CAD' WHERE "currency" IS DISTINCT FROM 'CAD';
