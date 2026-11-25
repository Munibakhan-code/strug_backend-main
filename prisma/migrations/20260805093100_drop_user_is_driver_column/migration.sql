-- is_driver is DERIVED from the driver_profile relation at login
-- (Boolean(driverProfile), PR #998) — it must never be a user column.
-- Drop the forbidden dormant column (added by #1050 / attempted by #1010).
ALTER TABLE "user" DROP COLUMN IF EXISTS "is_driver";
