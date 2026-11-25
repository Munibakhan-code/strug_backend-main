-- Internal Social Media + Campaign dashboards: coordination stores. All additive
-- (three brand-new tables + FKs + indexes); nothing existing is altered.

-- CreateTable
CREATE TABLE "social_account" (
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
CREATE TABLE "internal_campaign" (
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
CREATE TABLE "social_post" (
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
CREATE INDEX "idx_social_account_platform" ON "social_account"("platform");
CREATE INDEX "idx_social_account_status" ON "social_account"("status");
CREATE INDEX "idx_internal_campaign_status" ON "internal_campaign"("status");
CREATE INDEX "idx_internal_campaign_channel" ON "internal_campaign"("channel");
CREATE INDEX "idx_social_post_status" ON "social_post"("status");
CREATE INDEX "idx_social_post_scheduled" ON "social_post"("scheduled_for");
CREATE INDEX "idx_social_post_account" ON "social_post"("account_id");
CREATE INDEX "idx_social_post_campaign" ON "social_post"("campaign_id");

-- AddForeignKey
ALTER TABLE "social_post" ADD CONSTRAINT "social_post_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "social_account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "social_post" ADD CONSTRAINT "social_post_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "internal_campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
