-- #481/#11: one-time "re-upload your photo" flag, set when the null-dead-profile-media
-- script clears a purged (404) profile_pic_url / banner_url. Additive + idempotent.
ALTER TABLE "social_profile" ADD COLUMN IF NOT EXISTS "avatar_reset_notice" BOOLEAN NOT NULL DEFAULT false;
