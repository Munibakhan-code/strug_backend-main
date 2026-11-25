-- Scope quote_provider to one profile per user per vertical (insurance | mortgage).
-- Previously a single row per user caused insurance registration to open the mortgage dashboard.

ALTER TABLE "quote_provider" ADD COLUMN IF NOT EXISTS "vertical" VARCHAR(20);

-- Infer vertical from attached categories; default remaining rows to insurance.
UPDATE "quote_provider" qp
SET "vertical" = COALESCE((
  SELECT qc."vertical"
  FROM "quote_provider_category" qpc
  JOIN "quote_category" qc ON qc."quote_category_id" = qpc."quote_category_id"
  WHERE qpc."quote_provider_id" = qp."quote_provider_id"
    AND qc."vertical" IS NOT NULL
  GROUP BY qc."vertical"
  ORDER BY COUNT(*) DESC
  LIMIT 1
), 'insurance')
WHERE qp."vertical" IS NULL OR qp."vertical" = '';

UPDATE "quote_provider" SET "vertical" = 'insurance' WHERE "vertical" IS NULL OR "vertical" = '';

ALTER TABLE "quote_provider" ALTER COLUMN "vertical" SET DEFAULT 'insurance';
ALTER TABLE "quote_provider" ALTER COLUMN "vertical" SET NOT NULL;

-- Drop cross-vertical category links left over from the shared-profile bug.
DELETE FROM "quote_provider_category" qpc
USING "quote_provider" qp, "quote_category" qc
WHERE qpc."quote_provider_id" = qp."quote_provider_id"
  AND qpc."quote_category_id" = qc."quote_category_id"
  AND qc."vertical" IS DISTINCT FROM qp."vertical";

CREATE UNIQUE INDEX IF NOT EXISTS "uq_quote_provider_user_vertical"
  ON "quote_provider"("user_id", "vertical");

CREATE INDEX IF NOT EXISTS "idx_quote_provider_vertical"
  ON "quote_provider"("vertical");
