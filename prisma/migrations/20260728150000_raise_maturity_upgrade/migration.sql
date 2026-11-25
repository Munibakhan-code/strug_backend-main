ALTER TABLE "projects"
  ADD COLUMN "slug" VARCHAR(180),
  ADD COLUMN "category" VARCHAR(80),
  ADD COLUMN "campaign_type" VARCHAR(40) DEFAULT 'fundraiser',
  ADD COLUMN "status" VARCHAR(30) DEFAULT 'draft',
  ADD COLUMN "review_status" VARCHAR(30) DEFAULT 'pending',
  ADD COLUMN "review_notes" TEXT,
  ADD COLUMN "is_featured" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "is_hidden" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "submitted_at" TIMESTAMP(6),
  ADD COLUMN "published_at" TIMESTAMP(6),
  ADD COLUMN "approved_at" TIMESTAMP(6),
  ADD COLUMN "rejected_at" TIMESTAMP(6),
  ADD COLUMN "completed_at" TIMESTAMP(6);

ALTER TABLE "donations"
  ADD COLUMN "referral_code" VARCHAR(80),
  ADD COLUMN "paid_at" TIMESTAMP(6),
  ADD COLUMN "refunded_at" TIMESTAMP(6),
  ADD COLUMN "refund_status" VARCHAR(20) DEFAULT 'none',
  ADD COLUMN "refund_amount" DOUBLE PRECISION DEFAULT 0,
  ADD COLUMN "shipping_name" VARCHAR(255),
  ADD COLUMN "shipping_email" VARCHAR(255),
  ADD COLUMN "shipping_address" TEXT,
  ADD COLUMN "fulfillment_status" VARCHAR(30) DEFAULT 'not_required',
  ADD COLUMN "fulfillment_note" TEXT,
  ADD COLUMN "tracking_number" VARCHAR(255),
  ADD COLUMN "tracking_url" TEXT,
  ADD COLUMN "refunded_by_user_id" INTEGER;

ALTER TABLE "campaign_payout"
  ADD COLUMN "reviewed_at" TIMESTAMP(6),
  ADD COLUMN "approved_at" TIMESTAMP(6),
  ADD COLUMN "paid_at" TIMESTAMP(6),
  ADD COLUMN "rejected_at" TIMESTAMP(6),
  ADD COLUMN "rejection_reason" TEXT,
  ADD COLUMN "external_ref" VARCHAR(255);

UPDATE "projects"
SET
  "slug" = NULLIF(TRIM(BOTH '-' FROM REGEXP_REPLACE(LOWER(COALESCE("title", "project_name", 'campaign')), '[^a-z0-9]+', '-', 'g')), ''),
  "category" = COALESCE(NULLIF(TRIM("category"), ''), 'Community'),
  "campaign_type" = COALESCE(NULLIF(TRIM("campaign_type"), ''), 'fundraiser'),
  "status" = COALESCE(NULLIF(TRIM("status"), ''), 'live'),
  "review_status" = COALESCE(NULLIF(TRIM("review_status"), ''), 'approved'),
  "submitted_at" = COALESCE("submitted_at", "posted_date", NOW()),
  "published_at" = COALESCE("published_at", "posted_date", NOW()),
  "approved_at" = COALESCE("approved_at", "posted_date", NOW())
WHERE "slug" IS NULL
   OR "category" IS NULL
   OR "campaign_type" IS NULL
   OR "status" IS NULL
   OR "review_status" IS NULL;

UPDATE "donations"
SET
  "paid_at" = COALESCE("paid_at", CASE WHEN "payment_status" = 'paid' THEN "donated_date" ELSE NULL END),
  "refund_status" = COALESCE(NULLIF(TRIM("refund_status"), ''), 'none'),
  "refund_amount" = COALESCE("refund_amount", 0),
  "fulfillment_status" = COALESCE(NULLIF(TRIM("fulfillment_status"), ''), CASE WHEN "reward_tier_id" IS NULL THEN 'not_required' ELSE 'pending' END);

UPDATE "campaign_payout"
SET
  "reviewed_at" = COALESCE("reviewed_at", "created_at"),
  "approved_at" = COALESCE("approved_at", "created_at"),
  "paid_at" = COALESCE("paid_at", CASE WHEN "status" IN ('completed', 'paid') THEN "created_at" ELSE NULL END)
WHERE "status" IN ('completed', 'paid');

UPDATE "donations" d
SET "reward_tier_id" = NULL
WHERE "reward_tier_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "reward_tier" rt WHERE rt."tier_id" = d."reward_tier_id"
  );

-- De-duplicate backfilled slugs before enforcing uniqueness. Multiple existing
-- projects can slugify to the same base (e.g. same title, or all-NULL title/project_name
-- -> 'campaign'). Suffix every collision after the first with its project_id (the PK,
-- guaranteed unique) so CREATE UNIQUE INDEX below cannot fail and jam the migration.
WITH ranked AS (
  SELECT "project_id",
         ROW_NUMBER() OVER (PARTITION BY "slug" ORDER BY "project_id") AS rn
  FROM "projects"
  WHERE "slug" IS NOT NULL
)
UPDATE "projects" p
SET "slug" = p."slug" || '-' || p."project_id"
FROM ranked r
WHERE p."project_id" = r."project_id" AND r.rn > 1;

CREATE UNIQUE INDEX "projects_slug_key" ON "projects"("slug");
CREATE UNIQUE INDEX "campaign_payout_external_ref_key" ON "campaign_payout"("external_ref");
CREATE INDEX "idx_projects_status_review" ON "projects"("status", "review_status");
CREATE INDEX "idx_projects_category_type" ON "projects"("category", "campaign_type");
CREATE INDEX "idx_donations_project_payment" ON "donations"("project_id", "payment_status", "refund_status");
CREATE INDEX "idx_donations_reward_tier" ON "donations"("reward_tier_id");

ALTER TABLE "donations"
  ADD CONSTRAINT "donations_reward_tier_id_fkey"
  FOREIGN KEY ("reward_tier_id") REFERENCES "reward_tier"("tier_id")
  ON DELETE SET NULL ON UPDATE NO ACTION;
