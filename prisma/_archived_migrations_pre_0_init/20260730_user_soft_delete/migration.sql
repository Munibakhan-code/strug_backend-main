-- Soft-delete marker for accounts (powers User Management "Deleted Users").
-- Additive + idempotent. NULL = active account; a timestamp = soft-deleted.
-- No deletion flow writes this yet (the platform has no account-deletion endpoint),
-- so the Deleted Users view is empty until one lands — the column is the foundation.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "user_deleted_at_idx" ON "user" ("deleted_at");
