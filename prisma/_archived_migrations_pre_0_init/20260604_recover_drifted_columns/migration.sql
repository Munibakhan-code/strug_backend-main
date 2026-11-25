-- RECOVERY (round 2): several 2026-06-01..06-03 migrations were marked-applied in
-- prod's _prisma_migrations table but their SQL never ran (Neon advisory-lock /
-- `migrate resolve --applied` drift). 20260603_recover_drifted_tables already
-- recovered the missing TABLES (playlist, playlist_item, user_address) but NOT the
-- missing COLUMNS — so prod's "user"/"channel" tables still lack columns the current
-- Prisma client SELECTs by default. Every full-column query then hard-500s on prod
-- while staging is fine:
--   * login            -> prisma.user.findUnique (selects is_creator/password_changed_at)
--   * /channel/me, /channel/profile/:handle, /channel/subscriptions
--   * /video/recommendations/:id  (include: channel -> selects content_niche)
-- Verified on prod 2026-06-02: GET /channel/profile/<any> returns 500 (no crypto in
-- that path), confirming "channel"."content_niche" is missing.
--
-- This migration re-asserts every drift-window column/table idempotently. It is
-- PURELY ADDITIVE — ADD COLUMN / CREATE TABLE ... IF NOT EXISTS — so it is a no-op
-- anywhere the objects already exist (e.g. staging) and CANNOT drop or modify any
-- existing data. The single NOT NULL column carries a DEFAULT, so existing rows
-- backfill safely.

-- ── "user" (from 20260601_add_is_creator_content_niche, 20260603_add_password_changed_at) ──
ALTER TABLE "user"    ADD COLUMN IF NOT EXISTS "is_creator"          BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "user"    ADD COLUMN IF NOT EXISTS "password_changed_at" TIMESTAMP(3);

-- ── "channel" (from 20260601_add_is_creator_content_niche) — PROVEN missing on prod ──
ALTER TABLE "channel" ADD COLUMN IF NOT EXISTS "content_niche"       TEXT;

-- ── live streaming (from 20260602_live_playback_and_chat) ──
ALTER TABLE "live_session" ADD COLUMN IF NOT EXISTS "playback_url" VARCHAR(500);

CREATE TABLE IF NOT EXISTS "live_chat_message" (
    "message_id" SERIAL PRIMARY KEY,
    "session_id" INTEGER NOT NULL,
    "user_id"    INTEGER NOT NULL,
    "username"   VARCHAR(120),
    "text"       VARCHAR(500) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "live_chat_message_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "live_session"("session_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "live_chat_message_session_id_idx" ON "live_chat_message"("session_id");
