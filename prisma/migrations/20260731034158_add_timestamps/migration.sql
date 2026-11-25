-- DropIndex
DROP INDEX "campaign_payout_external_ref_key";

-- DropIndex
DROP INDEX "idx_donations_project_payment";

-- DropIndex
DROP INDEX "idx_donations_reward_tier";

-- DropIndex
DROP INDEX "idx_projects_category_type";

-- DropIndex
DROP INDEX "idx_projects_status_review";

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "vehicle" ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updated_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;
