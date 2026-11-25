-- Videos audit follow-up: watch-time integrity (L1 atomic views, A1' lifetime credit cap)
-- + content-moderation review queue (W8). Additive + idempotent — safe to apply manually
-- via psql on the drifted prod/staging DBs.

-- ── A1': per-(user,video) cumulative watch-time credit. Lets /ping cap the total credit a
-- single viewer can accrue for one video, so seeking back-and-forward can't re-credit the
-- same span indefinitely. ──────────────────────────────────────────────────────────────────
ALTER TABLE "watch_history"
    ADD COLUMN IF NOT EXISTS "credited_sec" INTEGER NOT NULL DEFAULT 0;

-- ── L1: exactly one watch_history row per (user, video) so the view-dedup + increment can be
-- made atomic (conditional update / insert-on-conflict). Collapse any pre-existing duplicates,
-- keeping the most-recently-watched row, before adding the unique index. ────────────────────
DELETE FROM "watch_history" a
    USING "watch_history" b
    WHERE a."user_id" = b."user_id"
      AND a."video_id" = b."video_id"
      AND (a."watched_at" < b."watched_at"
           OR (a."watched_at" = b."watched_at" AND a."id" < b."id"));

CREATE UNIQUE INDEX IF NOT EXISTS "watch_history_user_id_video_id_key"
    ON "watch_history" ("user_id", "video_id");

-- ── W8: content-safety moderation flag driving the admin review queue. NULL = nothing to
-- review. Values: 'sensitive' (NSFW-ish, served but flagged), 'auto_banned' (scan blocked it),
-- 'scan_unavailable' (scan failed / not configured → shipped unmoderated, needs a human look).
ALTER TABLE "video"
    ADD COLUMN IF NOT EXISTS "moderation_flag" VARCHAR(40);

CREATE INDEX IF NOT EXISTS "video_moderation_flag_idx" ON "video" ("moderation_flag");
