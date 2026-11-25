-- #1294 email_verification schema expiry / consume markers
ALTER TABLE "email_verification" ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMP(3);
ALTER TABLE "email_verification" ADD COLUMN IF NOT EXISTS "used_at" TIMESTAMP(3);

-- #1296 capability-token expiry columns (nullable: legacy tokens keep working until rotated)
ALTER TABLE "courier_order" ADD COLUMN IF NOT EXISTS "tracking_token_expires_at" TIMESTAMP(6);
ALTER TABLE "event_plan" ADD COLUMN IF NOT EXISTS "share_token_expires_at" TIMESTAMP(6);
ALTER TABLE "event_guest" ADD COLUMN IF NOT EXISTS "invite_token_expires_at" TIMESTAMP(6);
