-- CreateEnum
CREATE TYPE "FreelancerStatus" AS ENUM ('APPROVED', 'PENDING', 'REJECTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "GigStatus" AS ENUM ('ACTIVE', 'PAUSED', 'DRAFT', 'DELETED');

-- CreateEnum
CREATE TYPE "PackageType" AS ENUM ('BASIC', 'STANDARD', 'PREMIUM');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'DELIVERED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WalletTransactionType" AS ENUM ('ORDER', 'WITHDRAWAL');

-- CreateEnum
CREATE TYPE "WalletTransactionStatus" AS ENUM ('PENDING', 'AVAILABLE', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'PAID');

-- CreateTable
CREATE TABLE "BuyerProfile" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BuyerProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FreelancerProfile" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "display_name" VARCHAR(255) NOT NULL,
    "freelance_bio" TEXT,
    "tagline" VARCHAR(255),
    "country" VARCHAR(100),
    "city" VARCHAR(100),
    "languages" TEXT[],
    "skills" TEXT[],
    "status" "FreelancerStatus" NOT NULL DEFAULT 'APPROVED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FreelancerProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "slug" VARCHAR(150) NOT NULL,
    "icon" TEXT,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubCategory" (
    "id" SERIAL NOT NULL,
    "category_id" INTEGER NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "slug" VARCHAR(150) NOT NULL,

    CONSTRAINT "SubCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Gig" (
    "id" SERIAL NOT NULL,
    "freelancer_user_id" INTEGER NOT NULL,
    "category" VARCHAR(150) NOT NULL,
    "subcategory" VARCHAR(150) NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT NOT NULL,
    "images" JSONB NOT NULL,
    "packages" JSONB NOT NULL,
    "status" "GigStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Gig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" SERIAL NOT NULL,
    "buyer_user_id" INTEGER NOT NULL,
    "freelancer_user_id" INTEGER NOT NULL,
    "gig_id" INTEGER NOT NULL,
    "package_type" "PackageType" NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "requirements" TEXT,
    "requirement_files" JSONB,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "is_completed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Review" (
    "id" SERIAL NOT NULL,
    "order_id" INTEGER NOT NULL,
    "gig_id" INTEGER NOT NULL,
    "buyer_user_id" INTEGER NOT NULL,
    "freelancer_user_id" INTEGER NOT NULL,
    "rating" INTEGER NOT NULL,
    "review" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FreelancerWallet" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "pending_balance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "available_balance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_earned" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_withdrawn" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FreelancerWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FreelanceWalletTransaction" (
    "id" SERIAL NOT NULL,
    "wallet_id" INTEGER NOT NULL,
    "order_id" INTEGER,
    "buyer_user_id" INTEGER,
    "freelancer_user_id" INTEGER,
    "amount" DECIMAL(12,2) NOT NULL,
    "type" "WalletTransactionType" NOT NULL,
    "status" "WalletTransactionStatus" NOT NULL DEFAULT 'PENDING',
    "available_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FreelanceWalletTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WithdrawalRequest" (
    "id" SERIAL NOT NULL,
    "freelancer_user_id" INTEGER NOT NULL,
    "wallet_id" INTEGER NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" VARCHAR(50) NOT NULL,
    "account_title" VARCHAR(150) NOT NULL,
    "account_number" VARCHAR(100) NOT NULL,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'PENDING',
    "admin_note" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "WithdrawalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BuyerProfile_user_id_key" ON "BuyerProfile"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "FreelancerProfile_user_id_key" ON "FreelancerProfile"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "Category_slug_key" ON "Category"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "SubCategory_slug_key" ON "SubCategory"("slug");

-- CreateIndex
CREATE INDEX "SubCategory_category_id_idx" ON "SubCategory"("category_id");

-- CreateIndex
CREATE INDEX "Gig_freelancer_user_id_idx" ON "Gig"("freelancer_user_id");

-- CreateIndex
CREATE INDEX "Order_buyer_user_id_idx" ON "Order"("buyer_user_id");

-- CreateIndex
CREATE INDEX "Order_freelancer_user_id_idx" ON "Order"("freelancer_user_id");

-- CreateIndex
CREATE INDEX "Order_gig_id_idx" ON "Order"("gig_id");

-- CreateIndex
CREATE UNIQUE INDEX "Review_order_id_key" ON "Review"("order_id");

-- CreateIndex
CREATE INDEX "Review_gig_id_idx" ON "Review"("gig_id");

-- CreateIndex
CREATE INDEX "Review_freelancer_user_id_idx" ON "Review"("freelancer_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "FreelancerWallet_user_id_key" ON "FreelancerWallet"("user_id");

-- CreateIndex
CREATE INDEX "FreelanceWalletTransaction_wallet_id_idx" ON "FreelanceWalletTransaction"("wallet_id");

-- CreateIndex
CREATE INDEX "FreelanceWalletTransaction_order_id_idx" ON "FreelanceWalletTransaction"("order_id");

-- CreateIndex
CREATE INDEX "WithdrawalRequest_freelancer_user_id_idx" ON "WithdrawalRequest"("freelancer_user_id");

-- CreateIndex
CREATE INDEX "WithdrawalRequest_wallet_id_idx" ON "WithdrawalRequest"("wallet_id");

-- AddForeignKey
ALTER TABLE "SubCategory" ADD CONSTRAINT "SubCategory_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;
