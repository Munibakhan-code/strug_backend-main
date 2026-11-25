-- Epic 10 Phase 1: unified cross-vertical notification table.
--
-- Generalises work_notification (same shape, keyed on user_id) into ONE table every vertical
-- writes through services/notify.js. Purely additive: no existing table is touched, and the
-- four legacy siloed tables (social/work/quote/board) keep working unchanged. Idempotent so it
-- is safe to (re-)apply against a prod DB that may already carry manual drift.

CREATE TABLE IF NOT EXISTS "notification" (
    "notification_id" SERIAL PRIMARY KEY,
    "user_id"         INTEGER NOT NULL,
    "vertical"        VARCHAR(24) NOT NULL,
    "type"            VARCHAR(40) NOT NULL,
    "urgency"         VARCHAR(12) NOT NULL DEFAULT 'ambient',
    "title"           VARCHAR(180) NOT NULL,
    "body"            TEXT,
    "entity_type"     VARCHAR(32),
    "entity_id"       INTEGER,
    "action_url"      VARCHAR(255),
    "data"            JSONB,
    "is_read"         BOOLEAN NOT NULL DEFAULT false,
    "expires_at"      TIMESTAMP(6),
    "created_at"      TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- FK to user, matching the ON DELETE CASCADE / ON UPDATE NO ACTION used by work_notification.
-- Wrapped in a guard because ADD CONSTRAINT has no IF NOT EXISTS in this Postgres version.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'notification_user_fkey'
    ) THEN
        ALTER TABLE "notification"
            ADD CONSTRAINT "notification_user_fkey"
            FOREIGN KEY ("user_id") REFERENCES "user"("user_id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_notification_user_unread"
    ON "notification" ("user_id", "is_read", "created_at");
CREATE INDEX IF NOT EXISTS "idx_notification_user_vertical"
    ON "notification" ("user_id", "vertical", "created_at");
