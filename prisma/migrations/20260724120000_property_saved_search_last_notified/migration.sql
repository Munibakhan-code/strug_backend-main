-- Add watermark for saved-search alert matching (only notify on listings newer than this).
ALTER TABLE "property_saved_search"
  ADD COLUMN IF NOT EXISTS "last_notified_at" TIMESTAMP(6);

-- Existing rows: treat "now" as the floor so we don't spam with historical matches.
UPDATE "property_saved_search"
SET "last_notified_at" = NOW()
WHERE "last_notified_at" IS NULL;

-- Index the alert-matching predicate (kept in sync with schema.prisma @@index([alert_enabled])).
CREATE INDEX IF NOT EXISTS "idx_property_saved_search_alert"
  ON "property_saved_search" ("alert_enabled");
