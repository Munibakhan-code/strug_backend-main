-- Livabl-parity merchandising fields for preconstruction communities
ALTER TABLE "property" ADD COLUMN IF NOT EXISTS "incentives" JSONB;
ALTER TABLE "property" ADD COLUMN IF NOT EXISTS "move_in_homes" JSONB;
ALTER TABLE "property" ADD COLUMN IF NOT EXISTS "design_packages" JSONB;
