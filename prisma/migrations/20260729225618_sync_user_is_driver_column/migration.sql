-- Records a column that was already applied directly to this shared dev database
-- outside of migration tracking. No-op against the schema; resolved via
-- `prisma migrate resolve --applied` rather than executed.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "is_driver" BOOLEAN NOT NULL DEFAULT false;
