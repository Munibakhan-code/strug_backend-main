/*
  Warnings:

  - You are about to drop the column `buyer_user_id` on the `FreelanceWalletTransaction` table. All the data in the column will be lost.
  - You are about to drop the column `freelancer_user_id` on the `FreelanceWalletTransaction` table. All the data in the column will be lost.
  - You are about to drop the column `user_id` on the `FreelancerWallet` table. All the data in the column will be lost.
  - You are about to drop the column `freelancer_user_id` on the `Gig` table. All the data in the column will be lost.
  - You are about to drop the column `buyer_user_id` on the `Order` table. All the data in the column will be lost.
  - You are about to drop the column `freelancer_user_id` on the `Order` table. All the data in the column will be lost.
  - You are about to drop the column `buyer_user_id` on the `Review` table. All the data in the column will be lost.
  - You are about to drop the column `freelancer_user_id` on the `Review` table. All the data in the column will be lost.
  - You are about to drop the column `freelancer_user_id` on the `WithdrawalRequest` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[freelancer_profile_id]` on the table `FreelancerWallet` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `freelancer_profile_id` to the `FreelancerWallet` table without a default value. This is not possible if the table is not empty.
  - Added the required column `freelancer_profile_id` to the `Gig` table without a default value. This is not possible if the table is not empty.
  - Added the required column `buyer_profile_id` to the `Order` table without a default value. This is not possible if the table is not empty.
  - Added the required column `freelancer_profile_id` to the `Order` table without a default value. This is not possible if the table is not empty.
  - Added the required column `buyer_profile_id` to the `Review` table without a default value. This is not possible if the table is not empty.
  - Added the required column `freelancer_profile_id` to the `Review` table without a default value. This is not possible if the table is not empty.
  - Added the required column `freelancer_profile_id` to the `WithdrawalRequest` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "FreelancerWallet_user_id_key";

-- DropIndex
DROP INDEX "Gig_freelancer_user_id_idx";

-- DropIndex
DROP INDEX "Order_buyer_user_id_idx";

-- DropIndex
DROP INDEX "Order_freelancer_user_id_idx";

-- DropIndex
DROP INDEX "Review_freelancer_user_id_idx";

-- DropIndex
DROP INDEX "WithdrawalRequest_freelancer_user_id_idx";

-- AlterTable
ALTER TABLE "FreelanceWalletTransaction" DROP COLUMN "buyer_user_id",
DROP COLUMN "freelancer_user_id",
ADD COLUMN     "buyer_profile_id" INTEGER,
ADD COLUMN     "freelancer_profile_id" INTEGER;

-- AlterTable
ALTER TABLE "FreelancerWallet" DROP COLUMN "user_id",
ADD COLUMN     "freelancer_profile_id" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "Gig" DROP COLUMN "freelancer_user_id",
ADD COLUMN     "freelancer_profile_id" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "Order" DROP COLUMN "buyer_user_id",
DROP COLUMN "freelancer_user_id",
ADD COLUMN     "buyer_profile_id" INTEGER NOT NULL,
ADD COLUMN     "freelancer_profile_id" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "Review" DROP COLUMN "buyer_user_id",
DROP COLUMN "freelancer_user_id",
ADD COLUMN     "buyer_profile_id" INTEGER NOT NULL,
ADD COLUMN     "freelancer_profile_id" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "WithdrawalRequest" DROP COLUMN "freelancer_user_id",
ADD COLUMN     "freelancer_profile_id" INTEGER NOT NULL;

-- CreateIndex
CREATE INDEX "FreelanceWalletTransaction_buyer_profile_id_idx" ON "FreelanceWalletTransaction"("buyer_profile_id");

-- CreateIndex
CREATE INDEX "FreelanceWalletTransaction_freelancer_profile_id_idx" ON "FreelanceWalletTransaction"("freelancer_profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "FreelancerWallet_freelancer_profile_id_key" ON "FreelancerWallet"("freelancer_profile_id");

-- CreateIndex
CREATE INDEX "Gig_freelancer_profile_id_idx" ON "Gig"("freelancer_profile_id");

-- CreateIndex
CREATE INDEX "Order_buyer_profile_id_idx" ON "Order"("buyer_profile_id");

-- CreateIndex
CREATE INDEX "Order_freelancer_profile_id_idx" ON "Order"("freelancer_profile_id");

-- CreateIndex
CREATE INDEX "Review_buyer_profile_id_idx" ON "Review"("buyer_profile_id");

-- CreateIndex
CREATE INDEX "Review_freelancer_profile_id_idx" ON "Review"("freelancer_profile_id");

-- CreateIndex
CREATE INDEX "WithdrawalRequest_freelancer_profile_id_idx" ON "WithdrawalRequest"("freelancer_profile_id");
