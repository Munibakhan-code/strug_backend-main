-- Board #467: Profile Story Highlights — permanent, curated, reorderable collections of Stories
-- shown as circular bubbles on a profile. The social_highlight table + highlight_id FK on
-- social_story already exist; this migration only adds the two columns the management UI needs:
--
--   sort_order  — manual ascending display order of a profile's highlight bubbles. Defaults to 0
--                 so every existing row is inert; new highlights are appended past the current max.
--   updated_at  — touched whenever a highlight is renamed / re-covered / re-ordered.
--
-- Purely additive and idempotent (IF NOT EXISTS), safe to (re-)apply against a prod DB that may
-- carry manual drift.

ALTER TABLE "social_highlight" ADD COLUMN IF NOT EXISTS "sort_order" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "social_highlight" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;
