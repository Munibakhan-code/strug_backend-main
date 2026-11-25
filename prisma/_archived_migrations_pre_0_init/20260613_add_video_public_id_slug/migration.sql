-- Shareable video URLs: add a non-sequential public_id + slug to `video`, used to
-- build /v/{public_id}-{slug}. PURELY ADDITIVE + idempotent (ADD COLUMN IF NOT EXISTS,
-- CREATE UNIQUE INDEX IF NOT EXISTS, backfills guarded by WHERE ... IS NULL) so it is a
-- no-op where the columns already exist and is safe to re-run on the drift-prone prod DB.
--
-- POST-PROMOTION (main -> release) VERIFY on prod via psql — prod has a history of
-- migrations marked-applied-without-running, which would skip the backfill:
--   SELECT count(*) FROM "video" WHERE "public_id" IS NULL;   -- must be 0
-- If non-zero, just re-run the two UPDATE statements below (idempotent).

ALTER TABLE "video" ADD COLUMN IF NOT EXISTS "public_id" VARCHAR(16);
ALTER TABLE "video" ADD COLUMN IF NOT EXISTS "slug"      VARCHAR(80);

-- Backfill public_id: 12-char lowercase hex from a per-row random seed (non-sequential;
-- video_id mixed in only to guarantee distinct input per row). No pgcrypto dependency.
UPDATE "video"
   SET "public_id" = substr(md5(random()::text || clock_timestamp()::text || "video_id"::text), 1, 12)
 WHERE "public_id" IS NULL;

-- Backfill slug from title: lowercase, non-alphanumerics -> '-', trim leading/trailing
-- '-', cap at 80 chars (re-trim after the cut). NULL/empty titles -> 'video'.
UPDATE "video"
   SET "slug" = COALESCE(
         NULLIF(
           rtrim(
             left(
               trim(BOTH '-' FROM regexp_replace(lower(COALESCE("title", '')), '[^a-z0-9]+', '-', 'g')),
               80
             ),
             '-'
           ),
           ''
         ),
         'video'
       )
 WHERE "slug" IS NULL;

-- Unique index — name matches what Prisma derives for the @unique field on `public_id`.
CREATE UNIQUE INDEX IF NOT EXISTS "video_public_id_key" ON "video"("public_id");
