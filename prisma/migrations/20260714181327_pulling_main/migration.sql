-- NOTE (2026-07-15): hardened to be idempotent. The original auto-generated version failed on
-- staging at its first statement — `DROP INDEX "town_hall_post_content_trgm_idx"` — because that
-- pg_trgm index does not exist there (the extension was never allow-listed), which P3009-blocked
-- every later migration. The drops/renames below are drift-sync noise from the author's local
-- shadow DB; guarding them with IF EXISTS / IF NOT EXISTS lets the migration apply cleanly in any
-- environment while still creating the genuinely-new digital-services tables. No intent changed.

-- DropForeignKey
ALTER TABLE "journal_bucket_item" DROP CONSTRAINT IF EXISTS "journal_bucket_item_created_by_fkey";

-- DropForeignKey
ALTER TABLE "journal_time_capsule" DROP CONSTRAINT IF EXISTS "journal_time_capsule_created_by_fkey";

-- DropForeignKey
ALTER TABLE "journal_time_capsule" DROP CONSTRAINT IF EXISTS "journal_time_capsule_partner_id_fkey";

-- DropIndex
DROP INDEX IF EXISTS "town_hall_post_content_trgm_idx";

-- DropIndex
DROP INDEX IF EXISTS "town_hall_post_parent_id_is_pinned_created_at_idx";

-- DropIndex
DROP INDEX IF EXISTS "town_hall_post_processing_status_idx";

-- DropIndex
DROP INDEX IF EXISTS "town_hall_post_product_id_idx";

-- CreateTable
CREATE TABLE IF NOT EXISTS "internal_campaign" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "objective" TEXT,
    "channel" VARCHAR(30) NOT NULL DEFAULT 'multi',
    "status" VARCHAR(20) NOT NULL DEFAULT 'planning',
    "start_date" TIMESTAMP(3),
    "end_date" TIMESTAMP(3),
    "budget" DECIMAL(12,2),
    "spend" DECIMAL(12,2),
    "owner" INTEGER,
    "notes" TEXT,
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "internal_campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "social_account" (
    "id" SERIAL NOT NULL,
    "platform" VARCHAR(40) NOT NULL,
    "handle" VARCHAR(120) NOT NULL,
    "display_name" VARCHAR(160),
    "url" VARCHAR(500),
    "follower_count" INTEGER,
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "managed_by" INTEGER,
    "notes" TEXT,
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "social_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "social_post" (
    "id" SERIAL NOT NULL,
    "account_id" INTEGER,
    "campaign_id" INTEGER,
    "title" VARCHAR(200) NOT NULL,
    "caption" TEXT,
    "media_url" VARCHAR(500),
    "status" VARCHAR(20) NOT NULL DEFAULT 'idea',
    "scheduled_for" TIMESTAMP(3),
    "published_at" TIMESTAMP(3),
    "assigned_to" INTEGER,
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "social_post_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_internal_campaign_channel" ON "internal_campaign"("channel");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_internal_campaign_status" ON "internal_campaign"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_social_account_platform" ON "social_account"("platform");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_social_account_status" ON "social_account"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_social_post_account" ON "social_post"("account_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_social_post_campaign" ON "social_post"("campaign_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_social_post_scheduled" ON "social_post"("scheduled_for");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_social_post_status" ON "social_post"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "town_hall_post_parent_id_is_pinned_created_at_idx" ON "town_hall_post"("parent_id", "is_pinned", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "video_analytics_video_id_created_at_idx" ON "video_analytics"("video_id", "created_at");

-- RenameForeignKey (guarded: only rename when the old name exists and the new one does not)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wishlist_contribution_contributor_id_fkey')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wishlist_contribution_contributor_fkey') THEN
    ALTER TABLE "wishlist_contribution" RENAME CONSTRAINT "wishlist_contribution_contributor_id_fkey" TO "wishlist_contribution_contributor_fkey";
  END IF;
END $$;

-- RenameForeignKey (guarded)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wishlist_contribution_wishlist_item_id_fkey')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wishlist_contribution_item_fkey') THEN
    ALTER TABLE "wishlist_contribution" RENAME CONSTRAINT "wishlist_contribution_wishlist_item_id_fkey" TO "wishlist_contribution_item_fkey";
  END IF;
END $$;

-- AddForeignKey (guarded so a re-run is safe)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'social_post_account_id_fkey') THEN
    ALTER TABLE "social_post" ADD CONSTRAINT "social_post_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "social_account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey (guarded)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'social_post_campaign_id_fkey') THEN
    ALTER TABLE "social_post" ADD CONSTRAINT "social_post_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "internal_campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
