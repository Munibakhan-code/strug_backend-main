-- Community identity + customization (#261 / #262)
-- Additive & nullable-safe: new columns have defaults; handle is backfilled before NOT NULL.

ALTER TABLE "community" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'public';
ALTER TABLE "community" ADD COLUMN "nsfw" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "community" ADD COLUMN "banner_url" TEXT;
ALTER TABLE "community" ADD COLUMN "icon_url" TEXT;
ALTER TABLE "community" ADD COLUMN "pinned_post_ids" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];

-- handle: add nullable, backfill (strip leading "s/", slugify), fill blanks, dedupe, then enforce.
ALTER TABLE "community" ADD COLUMN "handle" TEXT;

UPDATE "community"
SET "handle" = NULLIF(
  trim(both '-' from lower(regexp_replace(regexp_replace("name", '^s/', '', 'i'), '[^a-zA-Z0-9]+', '-', 'g'))),
  ''
);

-- rows whose name slugified to empty
UPDATE "community" SET "handle" = 'c-' || substr("community_id", 1, 8) WHERE "handle" IS NULL;

-- resolve any collisions by appending a short id fragment
UPDATE "community" c
SET "handle" = c."handle" || '-' || substr(c."community_id", 1, 6)
WHERE EXISTS (
  SELECT 1 FROM "community" c2
  WHERE c2."handle" = c."handle" AND c2."community_id" <> c."community_id"
);

ALTER TABLE "community" ALTER COLUMN "handle" SET NOT NULL;
CREATE UNIQUE INDEX "community_handle_key" ON "community"("handle");
