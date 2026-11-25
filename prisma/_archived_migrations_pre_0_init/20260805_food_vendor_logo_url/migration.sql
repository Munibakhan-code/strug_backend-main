-- Add food_vendor.logo_url (vendor logo). The column was previously present in the schema
-- without a migration to create it, which left the prod DB missing the column and 500'd
-- every food_vendor read. This additive, idempotent migration creates it everywhere.
ALTER TABLE "food_vendor" ADD COLUMN IF NOT EXISTS "logo_url" VARCHAR(1000);
