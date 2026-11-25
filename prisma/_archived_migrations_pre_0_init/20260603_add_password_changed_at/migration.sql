-- Token invalidation on password change: tokens issued before this timestamp are rejected.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "password_changed_at" TIMESTAMP(3);
