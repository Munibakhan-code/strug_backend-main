-- RECOVERY: the ads-engine schema was added to schema.prisma with NO migration,
-- so the 7 ads_* tables + ad_impressions.event_type were missing on staging
-- (ads-engine-heartbeat: "The table public.ads_campaign does not exist").
-- Idempotent (IF NOT EXISTS / guarded FKs) — a no-op anywhere the objects already
-- exist (e.g. prod, which already has them).

ALTER TABLE "ad_impressions" ADD COLUMN IF NOT EXISTS "event_type" TEXT NOT NULL DEFAULT 'impression';

-- CreateTable
CREATE TABLE IF NOT EXISTS "ads_wallet" (
    "ads_wallet_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "balance" DECIMAL(12,4) NOT NULL DEFAULT 0.00,
    "currency" TEXT NOT NULL DEFAULT 'LKR',
    "status" TEXT NOT NULL DEFAULT 'active',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ads_wallet_pkey" PRIMARY KEY ("ads_wallet_id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ads_account_profile" (
    "profile_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "business_name" VARCHAR(255),
    "tax_id" VARCHAR(50),
    "brn" VARCHAR(50),
    "address" VARCHAR(500),
    "currency" TEXT NOT NULL DEFAULT 'LKR',
    "status" TEXT NOT NULL DEFAULT 'UNDER_REVIEW',
    "setup_completed" BOOLEAN NOT NULL DEFAULT false,
    "billing_threshold" DECIMAL(12,4) NOT NULL DEFAULT 0.00,
    "sandbox_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ads_account_profile_pkey" PRIMARY KEY ("profile_id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ads_member" (
    "member_id" SERIAL NOT NULL,
    "profile_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'ADVERTISER',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ads_member_pkey" PRIMARY KEY ("member_id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ads_brand_profile" (
    "brand_id" SERIAL NOT NULL,
    "profile_id" INTEGER NOT NULL,
    "brand_name" VARCHAR(255) NOT NULL,
    "logo_url" VARCHAR(500),
    "website" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ads_brand_profile_pkey" PRIMARY KEY ("brand_id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ads_tos_agreement" (
    "agreement_id" SERIAL NOT NULL,
    "profile_id" INTEGER NOT NULL,
    "signed_by_user_id" INTEGER NOT NULL,
    "ip_address" VARCHAR(45) NOT NULL,
    "signed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ads_tos_agreement_pkey" PRIMARY KEY ("agreement_id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ads_campaign" (
    "campaign_id" SERIAL NOT NULL,
    "ads_wallet_id" INTEGER NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "objective" TEXT NOT NULL DEFAULT 'AWARENESS',
    "folder_tag" VARCHAR(100),
    "main_category" TEXT NOT NULL DEFAULT 'SOCIAL',
    "sub_category" TEXT NOT NULL DEFAULT 'strug_insta',
    "ad_type" TEXT NOT NULL,
    "vertical" TEXT NOT NULL,
    "media_url" TEXT NOT NULL,
    "target_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "bid_type" TEXT NOT NULL,
    "bid_amount" DECIMAL(12,4) NOT NULL,
    "daily_budget" DECIMAL(12,4) NOT NULL,
    "spent_today" DECIMAL(12,4) NOT NULL DEFAULT 0.00,
    "total_budget" DECIMAL(12,4) NOT NULL,
    "total_spent" DECIMAL(12,4) NOT NULL DEFAULT 0.00,
    "target_countries" TEXT[],
    "target_cities" TEXT[],
    "target_interests" TEXT[],
    "placements" TEXT[],
    "frequency_cap" INTEGER DEFAULT 3,
    "dayparting_schedule" JSONB,
    "pacing_mode" TEXT NOT NULL DEFAULT 'STANDARD',
    "headline" VARCHAR(100),
    "description" VARCHAR(500),
    "cta_text" TEXT DEFAULT 'LEARN_MORE',
    "aspect_ratio" TEXT DEFAULT '1:1',
    "file_size_bytes" BIGINT DEFAULT 0,
    "duration_sec" INTEGER DEFAULT 0,
    "fallback_media_url" VARCHAR(500),
    "safety_score" DOUBLE PRECISION DEFAULT 1.0,
    "is_sensitive" BOOLEAN DEFAULT false,
    "media_hash" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ads_campaign_pkey" PRIMARY KEY ("campaign_id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ads_targeting_profile" (
    "targeting_id" SERIAL NOT NULL,
    "campaign_id" INTEGER NOT NULL,
    "min_age" INTEGER DEFAULT 13,
    "max_age" INTEGER DEFAULT 65,
    "genders" TEXT[],
    "languages" TEXT[],
    "device_platforms" TEXT[],
    "geofence_lat" DOUBLE PRECISION,
    "geofence_long" DOUBLE PRECISION,
    "geofence_radius_km" DOUBLE PRECISION,
    "lookalike_source_id" INTEGER,
    "excluded_profile_ids" INTEGER[],
    "connected_channel_ids" INTEGER[],

    CONSTRAINT "ads_targeting_profile_pkey" PRIMARY KEY ("targeting_id")
);
-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ads_wallet_user_id_key" ON "ads_wallet"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ads_account_profile_user_id_key" ON "ads_account_profile"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ads_member_profile_id_user_id_key" ON "ads_member"("profile_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ads_targeting_profile_campaign_id_key" ON "ads_targeting_profile"("campaign_id");


-- Foreign keys (guarded so re-runs are no-ops)
DO $$ BEGIN ALTER TABLE "ads_wallet" ADD CONSTRAINT "ads_wallet_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ads_account_profile" ADD CONSTRAINT "ads_account_profile_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ads_member" ADD CONSTRAINT "ads_member_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "ads_account_profile"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ads_member" ADD CONSTRAINT "ads_member_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ads_brand_profile" ADD CONSTRAINT "ads_brand_profile_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "ads_account_profile"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ads_tos_agreement" ADD CONSTRAINT "ads_tos_agreement_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "ads_account_profile"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ads_tos_agreement" ADD CONSTRAINT "ads_tos_agreement_signed_by_user_id_fkey" FOREIGN KEY ("signed_by_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ads_campaign" ADD CONSTRAINT "ads_campaign_ads_wallet_id_fkey" FOREIGN KEY ("ads_wallet_id") REFERENCES "ads_wallet"("ads_wallet_id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "ads_targeting_profile" ADD CONSTRAINT "ads_targeting_profile_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "ads_campaign"("campaign_id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
