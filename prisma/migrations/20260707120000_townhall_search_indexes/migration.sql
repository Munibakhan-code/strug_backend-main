-- Backfill: schema.prisma declared @@index([name]) on "user" and
-- @@index([display_name]) on "social_profile" for Town Hall search, but no
-- migration was ever generated for them, so they never existed in the DB
-- (schema drift) and the intended search speed-up never actually happened.
CREATE INDEX IF NOT EXISTS "user_name_idx" ON "user" ("name");
CREATE INDEX IF NOT EXISTS "social_profile_display_name_idx" ON "social_profile" ("display_name");

-- Drop: "user.username" already carries a UNIQUE constraint (@unique), which
-- Postgres backs with its own unique btree index ("user_username_key") that
-- already serves every exact-match username lookup. The separate plain
-- @@index([username]) was a second, redundant index on the same column --
-- pure write-amplification with no read benefit -- so schema.prisma no
-- longer declares it and this drops it from the database to match.
DROP INDEX IF EXISTS "user_username_idx";
