-- User activity event stream (powers User Management "Live Activity").
-- Additive + idempotent. Best-effort writes from services/activity-log.js.
CREATE TABLE IF NOT EXISTS "user_activity_event" (
  "event_id"    SERIAL       PRIMARY KEY,
  "user_id"     INTEGER      NOT NULL,
  "type"        VARCHAR(64)  NOT NULL,
  "description" TEXT,
  "ip_address"  VARCHAR(45),
  "user_agent"  TEXT,
  "source"      VARCHAR(16)  NOT NULL DEFAULT 'live',
  "metadata"    JSONB,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- FK to user; drop-create guarded so re-runs don't error.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_activity_event_user_id_fkey'
  ) THEN
    ALTER TABLE "user_activity_event"
      ADD CONSTRAINT "user_activity_event_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "user_activity_event_created_at_idx" ON "user_activity_event" ("created_at");
CREATE INDEX IF NOT EXISTS "user_activity_event_user_id_idx"    ON "user_activity_event" ("user_id");
CREATE INDEX IF NOT EXISTS "user_activity_event_type_idx"       ON "user_activity_event" ("type");

-- Seed signup history from existing profiles so the feed has content on day one.
-- JOIN to "user" guarantees FK validity; only runs when the table is still empty
-- (so a re-applied migration never double-seeds).
INSERT INTO "user_activity_event" ("user_id", "type", "description", "source", "created_at")
SELECT sp."user_id", 'user.signup', 'Account created', 'backfill', sp."created_at"
FROM "social_profile" sp
JOIN "user" u ON u."user_id" = sp."user_id"
WHERE NOT EXISTS (SELECT 1 FROM "user_activity_event");
