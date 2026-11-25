-- Town Hall: scheduled publishing + real view counter.
-- Additive and idempotent so it is safe to (re)apply against drifted environments.

ALTER TABLE "town_hall_post" ADD COLUMN IF NOT EXISTS "scheduled_at" TIMESTAMP(3);
ALTER TABLE "town_hall_post" ADD COLUMN IF NOT EXISTS "view_count" INTEGER NOT NULL DEFAULT 0;

-- Feeds frequently filter "is this post visible yet?" by scheduled_at.
CREATE INDEX IF NOT EXISTS "town_hall_post_scheduled_at_idx" ON "town_hall_post" ("scheduled_at");
