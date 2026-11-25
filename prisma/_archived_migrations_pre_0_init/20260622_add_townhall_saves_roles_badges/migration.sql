-- Town Hall post saves (bookmarks), user roles, and social_profile verification badges.
-- Written idempotently (drift-safe) to match the additive-migration convention.

-- ── Role enum + user.role ─────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "Role" AS ENUM ('USER', 'MODERATOR', 'ADMIN');
EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE "user"
  ADD COLUMN IF NOT EXISTS role "Role" NOT NULL DEFAULT 'USER';

-- ── VerificationType enum + social_profile.verification_type ──────────────────
DO $$ BEGIN
  CREATE TYPE "VerificationType" AS ENUM (
    'NONE', 'FAN_ACCOUNT', 'TOP_RATED', 'INDIVIDUAL', 'CHARITY',
    'CORPORATION', 'EDUCATIONAL', 'GOVERNMENT', 'MEDIA', 'PUBLIC_FIGURE'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE social_profile
  ADD COLUMN IF NOT EXISTS verification_type "VerificationType" NOT NULL DEFAULT 'NONE';

-- ── town_hall_post_save ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS town_hall_post_save (
  save_id    SERIAL PRIMARY KEY,
  post_id    INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT fk_thps_post FOREIGN KEY(post_id) REFERENCES town_hall_post(post_id) ON DELETE CASCADE,
  CONSTRAINT fk_thps_user FOREIGN KEY(user_id) REFERENCES "user"(user_id) ON DELETE CASCADE,
  UNIQUE (post_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_town_hall_post_save_post ON town_hall_post_save (post_id);
CREATE INDEX IF NOT EXISTS idx_town_hall_post_save_user ON town_hall_post_save (user_id);
