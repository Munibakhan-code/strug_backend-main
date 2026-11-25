-- Town Hall search indexes.
--
-- The personalized-feed / search work (services/townhall-recommender.js) declared
-- @@index([name]) on "user" and @@index([display_name]) on "social_profile" in
-- schema.prisma but shipped WITHOUT a migration, so the indexes never existed in the
-- database (schema drift + the intended search speed-up was never realized). This
-- migration backfills exactly those two indexes, using the names Prisma expects
-- (<table>_<column>_idx) so schema and database are back in sync.
--
-- NOTE: "user".username already carries a UNIQUE index ("user_username_key") from its
-- @unique attribute, which already serves username lookups — a second plain index
-- would be redundant, so the corresponding @@index([username]) was removed from the
-- schema rather than indexed again here.
--
-- FULLY ADDITIVE + IDEMPOTENT: re-running is a no-op; no column/table is altered.

CREATE INDEX IF NOT EXISTS "user_name_idx"                   ON "user"("name");
CREATE INDEX IF NOT EXISTS "social_profile_display_name_idx" ON "social_profile"("display_name");
