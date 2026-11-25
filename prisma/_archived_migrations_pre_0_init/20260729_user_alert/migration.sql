-- User risk/attention alerts (powers User Management "Alerts & Warnings").
-- Additive + idempotent. Reconciled by services/user-alerts.js.
CREATE TABLE IF NOT EXISTS "user_alert" (
  "alert_id"   SERIAL       PRIMARY KEY,
  "user_id"    INTEGER      NOT NULL,
  "type"       VARCHAR(64)  NOT NULL,
  "severity"   VARCHAR(16)  NOT NULL DEFAULT 'warning',
  "message"    TEXT         NOT NULL,
  "status"     VARCHAR(16)  NOT NULL DEFAULT 'open',
  "metadata"   JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_alert_user_id_fkey') THEN
    ALTER TABLE "user_alert"
      ADD CONSTRAINT "user_alert_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- One alert per (user, type) so the sync can upsert.
CREATE UNIQUE INDEX IF NOT EXISTS "user_alert_user_id_type_key" ON "user_alert" ("user_id", "type");
CREATE INDEX IF NOT EXISTS "user_alert_status_idx"   ON "user_alert" ("status");
CREATE INDEX IF NOT EXISTS "user_alert_severity_idx" ON "user_alert" ("severity");
