-- Add optional bio/description to store_profile (food/grocery/etc. store dashboards).
-- Additive + idempotent: prod has migration drift, so guard with IF NOT EXISTS.
ALTER TABLE "store_profile" ADD COLUMN IF NOT EXISTS "bio" VARCHAR(2000);
