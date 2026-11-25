/*
  Warnings:

  - You are about to drop the `Order` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'CANCELLED', 'REFUNDED');

-- DropForeignKey
ALTER TABLE "FreelanceWalletTransaction" DROP CONSTRAINT "FreelanceWalletTransaction_order_id_fkey";

-- DropForeignKey
ALTER TABLE "Order" DROP CONSTRAINT "Order_buyer_profile_id_fkey";

-- DropForeignKey
ALTER TABLE "Order" DROP CONSTRAINT "Order_freelancer_profile_id_fkey";

-- DropForeignKey
ALTER TABLE "Order" DROP CONSTRAINT "Order_gig_id_fkey";

-- DropForeignKey
ALTER TABLE "Review" DROP CONSTRAINT "Review_order_id_fkey";

-- DropIndex
DROP INDEX "Review_gig_id_idx";

-- DropTable
DROP TABLE "Order";

-- CreateTable
CREATE TABLE "FreelancerOrder" (
    "id" SERIAL NOT NULL,
    "buyer_profile_id" INTEGER NOT NULL,
    "freelancer_profile_id" INTEGER NOT NULL,
    "gig_id" INTEGER NOT NULL,
    "package_type" "PackageType" NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "requirements" TEXT,
    "requirement_files" JSONB,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "stripe_payment_intent_id" TEXT,
    "payment_status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "is_completed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "FreelancerOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FreelancerOrder_stripe_payment_intent_id_key" ON "FreelancerOrder"("stripe_payment_intent_id");

-- CreateIndex
CREATE INDEX "FreelancerOrder_buyer_profile_id_idx" ON "FreelancerOrder"("buyer_profile_id");

-- CreateIndex
CREATE INDEX "FreelancerOrder_freelancer_profile_id_idx" ON "FreelancerOrder"("freelancer_profile_id");

-- CreateIndex
CREATE INDEX "FreelancerOrder_gig_id_idx" ON "FreelancerOrder"("gig_id");

-- CreateIndex
CREATE INDEX "FreelancerOrder_status_idx" ON "FreelancerOrder"("status");

-- CreateIndex
CREATE INDEX "BuyerProfile_user_id_idx" ON "BuyerProfile"("user_id");

-- CreateIndex
CREATE INDEX "FreelanceWalletTransaction_status_idx" ON "FreelanceWalletTransaction"("status");

-- CreateIndex
CREATE INDEX "FreelanceWalletTransaction_type_idx" ON "FreelanceWalletTransaction"("type");

-- CreateIndex
CREATE INDEX "FreelancerProfile_user_id_idx" ON "FreelancerProfile"("user_id");

-- CreateIndex
CREATE INDEX "FreelancerWallet_freelancer_profile_id_idx" ON "FreelancerWallet"("freelancer_profile_id");

-- CreateIndex
CREATE INDEX "Gig_status_idx" ON "Gig"("status");

-- CreateIndex
CREATE INDEX "Gig_Freelance_SubCategory_idx" ON "Gig"("Freelance_SubCategory");

-- CreateIndex
CREATE INDEX "Review_order_id_idx" ON "Review"("order_id");

-- CreateIndex
CREATE INDEX "WithdrawalRequest_status_idx" ON "WithdrawalRequest"("status");

-- AddForeignKey
ALTER TABLE "FreelancerOrder" ADD CONSTRAINT "FreelancerOrder_buyer_profile_id_fkey" FOREIGN KEY ("buyer_profile_id") REFERENCES "BuyerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FreelancerOrder" ADD CONSTRAINT "FreelancerOrder_freelancer_profile_id_fkey" FOREIGN KEY ("freelancer_profile_id") REFERENCES "FreelancerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FreelancerOrder" ADD CONSTRAINT "FreelancerOrder_gig_id_fkey" FOREIGN KEY ("gig_id") REFERENCES "Gig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "FreelancerOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FreelanceWalletTransaction" ADD CONSTRAINT "FreelanceWalletTransaction_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "FreelancerOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
