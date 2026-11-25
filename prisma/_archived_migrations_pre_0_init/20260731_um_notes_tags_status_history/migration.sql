-- User Management: account-status controls (Tier C) + internal notes/tags + profile
-- history (Tier B). All additive + idempotent so it replays safely on the drifted
-- shared DBs (prod has migration-drift history — see backend CLAUDE.md).

-- ── Tier C: account status & force-logout on the user row ───────────────────────
-- account_status: 'active' (default) | 'restricted' | 'suspended' | 'banned'.
--   restricted = soft flag, can still sign in; suspended/banned = sign-in blocked
--   (enforced in middleware/authentication.js, fail-open if the column is missing).
-- sessions_invalidated_at: a stateless "force logout" marker — access tokens issued
--   before this instant are rejected (mirrors the existing password_changed_at check).
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "account_status"          VARCHAR(16) NOT NULL DEFAULT 'active';
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "status_reason"           TEXT;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "status_changed_at"       TIMESTAMP(3);
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "status_changed_by"       INTEGER;   -- board_member.member_id
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "sessions_invalidated_at" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "user_account_status_idx" ON "user" ("account_status");

-- ── Tier B: internal notes (free-text staff annotations on an account) ──────────
CREATE TABLE IF NOT EXISTS "user_note" (
  "note_id"          SERIAL       PRIMARY KEY,
  "user_id"          INTEGER      NOT NULL,
  "author_member_id" INTEGER,                 -- board_member who wrote it (no FK; advisory)
  "author_name"      VARCHAR(255),            -- denormalized for display
  "body"             TEXT         NOT NULL,
  "pinned"           BOOLEAN      NOT NULL DEFAULT false,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_note_user_id_fkey') THEN
    ALTER TABLE "user_note"
      ADD CONSTRAINT "user_note_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "user_note_user_id_idx" ON "user_note" ("user_id");

-- ── Tier B: tags / segments (VIP, Watchlist, Priority, High Risk + custom) ──────
CREATE TABLE IF NOT EXISTS "user_tag" (
  "tag_id"                SERIAL      PRIMARY KEY,
  "user_id"               INTEGER     NOT NULL,
  "tag"                   VARCHAR(64) NOT NULL,
  "color"                 VARCHAR(16),
  "created_by_member_id"  INTEGER,
  "created_by_name"       VARCHAR(255),
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_tag_user_id_fkey') THEN
    ALTER TABLE "user_tag"
      ADD CONSTRAINT "user_tag_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
-- One row per (user, tag) so toggling a tag is an idempotent upsert.
CREATE UNIQUE INDEX IF NOT EXISTS "user_tag_user_id_tag_key" ON "user_tag" ("user_id", "tag");
CREATE INDEX IF NOT EXISTS "user_tag_tag_idx" ON "user_tag" ("tag");

-- ── Tier B: profile change history (username / display_name / verification …) ───
-- Recorded best-effort going forward (services/profile-history.js, fire-and-forget);
-- empty until the first change lands, same pattern as user_activity_event's live tail.
CREATE TABLE IF NOT EXISTS "user_profile_history" (
  "history_id" SERIAL       PRIMARY KEY,
  "user_id"    INTEGER      NOT NULL,
  "field"      VARCHAR(64)  NOT NULL,   -- 'handle' | 'username' | 'display_name' | 'verification' | …
  "old_value"  TEXT,
  "new_value"  TEXT,
  "changed_by" VARCHAR(32)  NOT NULL DEFAULT 'user',  -- 'user' | 'admin' | 'system'
  "actor_id"   INTEGER,                 -- the acting user/member id when known
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_profile_history_user_id_fkey') THEN
    ALTER TABLE "user_profile_history"
      ADD CONSTRAINT "user_profile_history_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "user_profile_history_user_id_idx" ON "user_profile_history" ("user_id");
CREATE INDEX IF NOT EXISTS "user_profile_history_field_idx"   ON "user_profile_history" ("field");
