-- Town Hall search + feed performance backfill
--
-- 1) schema.prisma has declared `@@index([name])` on `user` and
--    `@@index([display_name])` on `social_profile` for a while, but no
--    migration ever shipped them — classic schema drift. Postgres never
--    actually built these indexes, so every name/handle search has been a
--    full table scan the whole time. Backfilled here.
--
-- 2) `user.username` already carries a UNIQUE index (from the `@unique`
--    attribute), which fully serves username lookups on its own. The extra
--    plain `@@index([username])` was dead weight (double the write-time
--    index maintenance for zero read benefit) — dropped.
--
-- 3) Town Hall's home-feed query filters `parent_id IS NULL` and orders by
--    `is_pinned DESC, created_at DESC` on every single request, with no
--    supporting index — full scan + sort per page. Added a composite index.
--
-- 4) The new free-text /town-hall/search-posts endpoint does a
--    case-insensitive `contains` match on post content. A trigram (GIN)
--    index is what actually makes that fast instead of a sequential scan.
--
-- All statements are idempotent (IF EXISTS / IF NOT EXISTS) so this is safe
-- to run against environments that may already have some of these objects,
-- and safe to re-run if it partially applies.

CREATE INDEX IF NOT EXISTS "user_name_idx"
    ON "user" ("name");

CREATE INDEX IF NOT EXISTS "social_profile_display_name_idx"
    ON "social_profile" ("display_name");

-- If your DB's actual index name differs from Prisma's default naming
-- convention, check with `\d "user"` in psql and adjust this line — DROP
-- INDEX IF EXISTS makes this a no-op rather than an error either way.
DROP INDEX IF EXISTS "user_username_idx";

CREATE INDEX IF NOT EXISTS "town_hall_post_parent_id_is_pinned_created_at_idx"
    ON "town_hall_post" ("parent_id", "is_pinned", "created_at" DESC);

-- pg_trgm is not on Azure Postgres Flexible Server's default extension allow-list
-- (staging runs on Neon, which allows it, so this was invisible until prod). A bare
-- `CREATE EXTENSION pg_trgm` there raises and fails the WHOLE migration, leaving the
-- DB in a P3009 "failed migration" state that blocks every subsequent migrate deploy.
-- Wrap it so the extension + trigram index are best-effort: created where allowed,
-- skipped with a notice where not. Exact-match/`contains` search still works without
-- the trigram index (just via seq scan), so degrading gracefully is correct here.
DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE INDEX IF NOT EXISTS "town_hall_post_content_trgm_idx"
        ON "town_hall_post" USING gin ("content" gin_trgm_ops);
EXCEPTION WHEN OTHERS THEN
    -- Azure Flexible Server reports a non-allow-listed extension with varying
    -- SQLSTATEs (42501 / 0A000 / custom), so catch broadly: the whole point is
    -- that a missing pg_trgm must never fail this migration.
    RAISE NOTICE 'pg_trgm unavailable on this server (%) — skipping trigram index; search falls back to seq scan.', SQLERRM;
END
$$;
