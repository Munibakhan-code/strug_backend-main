-- #1293: one flo_user per account; required flo_user_id on health child rows.
-- Dedupe keeps the lowest flo_user_id per user_id and re-points children before delete.

-- Orphan child rows (no flo profile) cannot satisfy NOT NULL.
DELETE FROM "cycle_prediction" WHERE "flo_user_id" IS NULL;
DELETE FROM "period" WHERE "flo_user_id" IS NULL;
DELETE FROM "symptom_log" WHERE "flo_user_id" IS NULL;

-- Flo profiles with no owning user cannot become required user_id.
DELETE FROM "cycle_prediction"
WHERE "flo_user_id" IN (SELECT "flo_user_id" FROM "flo_user" WHERE "user_id" IS NULL);
DELETE FROM "period"
WHERE "flo_user_id" IN (SELECT "flo_user_id" FROM "flo_user" WHERE "user_id" IS NULL);
DELETE FROM "symptom_log"
WHERE "flo_user_id" IN (SELECT "flo_user_id" FROM "flo_user" WHERE "user_id" IS NULL);
DELETE FROM "flo_user" WHERE "user_id" IS NULL;

-- Collapse duplicate flo_user rows per user_id (keep min id).
WITH keepers AS (
  SELECT "user_id", MIN("flo_user_id") AS keep_id
  FROM "flo_user"
  WHERE "user_id" IS NOT NULL
  GROUP BY "user_id"
  HAVING COUNT(*) > 1
),
dupes AS (
  SELECT f."flo_user_id" AS dupe_id, k.keep_id
  FROM "flo_user" f
  JOIN keepers k ON k."user_id" = f."user_id"
  WHERE f."flo_user_id" <> k.keep_id
)
UPDATE "cycle_prediction" cp
SET "flo_user_id" = d.keep_id
FROM dupes d
WHERE cp."flo_user_id" = d.dupe_id;

WITH keepers AS (
  SELECT "user_id", MIN("flo_user_id") AS keep_id
  FROM "flo_user"
  WHERE "user_id" IS NOT NULL
  GROUP BY "user_id"
  HAVING COUNT(*) > 1
),
dupes AS (
  SELECT f."flo_user_id" AS dupe_id, k.keep_id
  FROM "flo_user" f
  JOIN keepers k ON k."user_id" = f."user_id"
  WHERE f."flo_user_id" <> k.keep_id
)
UPDATE "period" p
SET "flo_user_id" = d.keep_id
FROM dupes d
WHERE p."flo_user_id" = d.dupe_id;

WITH keepers AS (
  SELECT "user_id", MIN("flo_user_id") AS keep_id
  FROM "flo_user"
  WHERE "user_id" IS NOT NULL
  GROUP BY "user_id"
  HAVING COUNT(*) > 1
),
dupes AS (
  SELECT f."flo_user_id" AS dupe_id, k.keep_id
  FROM "flo_user" f
  JOIN keepers k ON k."user_id" = f."user_id"
  WHERE f."flo_user_id" <> k.keep_id
)
UPDATE "symptom_log" s
SET "flo_user_id" = d.keep_id
FROM dupes d
WHERE s."flo_user_id" = d.dupe_id;

DELETE FROM "flo_user" f
USING (
  SELECT "user_id", MIN("flo_user_id") AS keep_id
  FROM "flo_user"
  WHERE "user_id" IS NOT NULL
  GROUP BY "user_id"
  HAVING COUNT(*) > 1
) k
WHERE f."user_id" = k."user_id"
  AND f."flo_user_id" <> k.keep_id;

-- Enforce required owners.
ALTER TABLE "flo_user" ALTER COLUMN "user_id" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "flo_user_user_id_key" ON "flo_user"("user_id");

ALTER TABLE "cycle_prediction" ALTER COLUMN "flo_user_id" SET NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_cycle_prediction_flo_user" ON "cycle_prediction"("flo_user_id");

ALTER TABLE "period" ALTER COLUMN "flo_user_id" SET NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_period_flo_user" ON "period"("flo_user_id");

ALTER TABLE "symptom_log" ALTER COLUMN "flo_user_id" SET NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_symptom_log_flo_user" ON "symptom_log"("flo_user_id");
