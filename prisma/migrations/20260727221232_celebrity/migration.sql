-- CreateEnum
CREATE TYPE "CelebrityStatus" AS ENUM ('APPROVED', 'PENDING', 'REJECTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "CelebrityListingStatus" AS ENUM ('ACTIVE', 'PAUSED', 'DRAFT', 'DELETED');

-- CreateEnum
CREATE TYPE "CelebrityBookingStatus" AS ENUM ('PENDING', 'ACCEPTED', 'RECORDING', 'DELIVERED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CelebrityPaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "CelebrityMessageType" AS ENUM ('MYSELF', 'SOMEONE_ELSE');

-- CreateEnum
CREATE TYPE "CelebrityWalletTransactionType" AS ENUM ('BOOKING', 'WITHDRAWAL');

-- CreateEnum
CREATE TYPE "CelebrityWalletTransactionStatus" AS ENUM ('PENDING', 'AVAILABLE', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "CelebrityWithdrawalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'PAID');

-- CreateTable
CREATE TABLE "CelebrityBuyerProfile" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CelebrityBuyerProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CelebrityProfile" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "display_name" VARCHAR(255) NOT NULL,
    "celebrity_bio" TEXT,
    "tagline" VARCHAR(255),
    "country" VARCHAR(100),
    "city" VARCHAR(100),
    "languages" TEXT[],
    "profile_image" TEXT,
    "cover_image" TEXT,
    "rating" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_reviews" INTEGER NOT NULL DEFAULT 0,
    "total_bookings" INTEGER NOT NULL DEFAULT 0,
    "status" "CelebrityStatus" NOT NULL DEFAULT 'APPROVED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CelebrityProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CelebrityListing" (
    "id" SERIAL NOT NULL,
    "celebrity_profile_id" INTEGER NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT NOT NULL,
    "category" VARCHAR(100) NOT NULL,
    "known_for" VARCHAR(255) NOT NULL,
    "location" VARCHAR(255),
    "price_per_video" DECIMAL(12,2) NOT NULL,
    "turnaround_days" INTEGER NOT NULL,
    "photos" JSONB NOT NULL,
    "status" "CelebrityListingStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CelebrityListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CelebrityBooking" (
    "id" SERIAL NOT NULL,
    "buyer_profile_id" INTEGER NOT NULL,
    "celebrity_profile_id" INTEGER NOT NULL,
    "listing_id" INTEGER NOT NULL,
    "message_type" "CelebrityMessageType" NOT NULL,
    "recipient_name" VARCHAR(255),
    "request_message" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "video_url" VARCHAR(1000),
    "payment_status" "CelebrityPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "status" "CelebrityBookingStatus" NOT NULL DEFAULT 'PENDING',
    "stripe_payment_intent_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "CelebrityBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CelebrityReview" (
    "id" SERIAL NOT NULL,
    "booking_id" INTEGER NOT NULL,
    "listing_id" INTEGER NOT NULL,
    "buyer_profile_id" INTEGER NOT NULL,
    "celebrity_profile_id" INTEGER NOT NULL,
    "rating" INTEGER NOT NULL,
    "review" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CelebrityReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CelebrityWallet" (
    "id" SERIAL NOT NULL,
    "celebrity_profile_id" INTEGER NOT NULL,
    "pending_balance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "available_balance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_earned" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_withdrawn" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CelebrityWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CelebrityWalletTransaction" (
    "id" SERIAL NOT NULL,
    "wallet_id" INTEGER NOT NULL,
    "booking_id" INTEGER,
    "buyer_profile_id" INTEGER,
    "celebrity_profile_id" INTEGER,
    "amount" DECIMAL(12,2) NOT NULL,
    "type" "CelebrityWalletTransactionType" NOT NULL,
    "status" "CelebrityWalletTransactionStatus" NOT NULL DEFAULT 'PENDING',
    "available_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CelebrityWalletTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CelebrityWithdrawalRequest" (
    "id" SERIAL NOT NULL,
    "celebrity_profile_id" INTEGER NOT NULL,
    "wallet_id" INTEGER NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" VARCHAR(50) NOT NULL,
    "account_title" VARCHAR(150) NOT NULL,
    "account_number" VARCHAR(100) NOT NULL,
    "status" "CelebrityWithdrawalStatus" NOT NULL DEFAULT 'PENDING',
    "admin_note" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CelebrityWithdrawalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CelebrityBuyerProfile_user_id_key" ON "CelebrityBuyerProfile"("user_id");

-- CreateIndex
CREATE INDEX "CelebrityBuyerProfile_user_id_idx" ON "CelebrityBuyerProfile"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "CelebrityProfile_user_id_key" ON "CelebrityProfile"("user_id");

-- CreateIndex
CREATE INDEX "CelebrityProfile_user_id_idx" ON "CelebrityProfile"("user_id");

-- CreateIndex
CREATE INDEX "CelebrityProfile_status_idx" ON "CelebrityProfile"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CelebrityListing_celebrity_profile_id_key" ON "CelebrityListing"("celebrity_profile_id");

-- CreateIndex
CREATE INDEX "CelebrityListing_status_idx" ON "CelebrityListing"("status");

-- CreateIndex
CREATE INDEX "CelebrityListing_category_idx" ON "CelebrityListing"("category");

-- CreateIndex
CREATE UNIQUE INDEX "CelebrityBooking_stripe_payment_intent_id_key" ON "CelebrityBooking"("stripe_payment_intent_id");

-- CreateIndex
CREATE INDEX "CelebrityBooking_buyer_profile_id_idx" ON "CelebrityBooking"("buyer_profile_id");

-- CreateIndex
CREATE INDEX "CelebrityBooking_celebrity_profile_id_idx" ON "CelebrityBooking"("celebrity_profile_id");

-- CreateIndex
CREATE INDEX "CelebrityBooking_listing_id_idx" ON "CelebrityBooking"("listing_id");

-- CreateIndex
CREATE INDEX "CelebrityBooking_status_idx" ON "CelebrityBooking"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CelebrityReview_booking_id_key" ON "CelebrityReview"("booking_id");

-- CreateIndex
CREATE INDEX "CelebrityReview_buyer_profile_id_idx" ON "CelebrityReview"("buyer_profile_id");

-- CreateIndex
CREATE INDEX "CelebrityReview_celebrity_profile_id_idx" ON "CelebrityReview"("celebrity_profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "CelebrityWallet_celebrity_profile_id_key" ON "CelebrityWallet"("celebrity_profile_id");

-- CreateIndex
CREATE INDEX "CelebrityWallet_celebrity_profile_id_idx" ON "CelebrityWallet"("celebrity_profile_id");

-- CreateIndex
CREATE INDEX "CelebrityWalletTransaction_wallet_id_idx" ON "CelebrityWalletTransaction"("wallet_id");

-- CreateIndex
CREATE INDEX "CelebrityWalletTransaction_booking_id_idx" ON "CelebrityWalletTransaction"("booking_id");

-- CreateIndex
CREATE INDEX "CelebrityWalletTransaction_status_idx" ON "CelebrityWalletTransaction"("status");

-- CreateIndex
CREATE INDEX "CelebrityWithdrawalRequest_celebrity_profile_id_idx" ON "CelebrityWithdrawalRequest"("celebrity_profile_id");

-- CreateIndex
CREATE INDEX "CelebrityWithdrawalRequest_wallet_id_idx" ON "CelebrityWithdrawalRequest"("wallet_id");

-- CreateIndex
CREATE INDEX "CelebrityWithdrawalRequest_status_idx" ON "CelebrityWithdrawalRequest"("status");

-- CreateIndex
CREATE INDEX "subscription_channel_id_created_at_idx" ON "subscription"("channel_id", "created_at");

-- CreateIndex
CREATE INDEX "video_title_idx" ON "video" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "video_comments_video_id_created_at_idx" ON "video_comments"("video_id", "created_at");

-- CreateIndex
CREATE INDEX "video_likes_video_id_is_like_created_at_idx" ON "video_likes"("video_id", "is_like", "created_at");

-- AddForeignKey
ALTER TABLE "CelebrityBuyerProfile" ADD CONSTRAINT "CelebrityBuyerProfile_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CelebrityProfile" ADD CONSTRAINT "CelebrityProfile_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CelebrityListing" ADD CONSTRAINT "CelebrityListing_celebrity_profile_id_fkey" FOREIGN KEY ("celebrity_profile_id") REFERENCES "CelebrityProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CelebrityBooking" ADD CONSTRAINT "CelebrityBooking_buyer_profile_id_fkey" FOREIGN KEY ("buyer_profile_id") REFERENCES "CelebrityBuyerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CelebrityBooking" ADD CONSTRAINT "CelebrityBooking_celebrity_profile_id_fkey" FOREIGN KEY ("celebrity_profile_id") REFERENCES "CelebrityProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CelebrityBooking" ADD CONSTRAINT "CelebrityBooking_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "CelebrityListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CelebrityReview" ADD CONSTRAINT "CelebrityReview_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "CelebrityBooking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CelebrityReview" ADD CONSTRAINT "CelebrityReview_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "CelebrityListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CelebrityReview" ADD CONSTRAINT "CelebrityReview_buyer_profile_id_fkey" FOREIGN KEY ("buyer_profile_id") REFERENCES "CelebrityBuyerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CelebrityReview" ADD CONSTRAINT "CelebrityReview_celebrity_profile_id_fkey" FOREIGN KEY ("celebrity_profile_id") REFERENCES "CelebrityProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CelebrityWallet" ADD CONSTRAINT "CelebrityWallet_celebrity_profile_id_fkey" FOREIGN KEY ("celebrity_profile_id") REFERENCES "CelebrityProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CelebrityWalletTransaction" ADD CONSTRAINT "CelebrityWalletTransaction_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "CelebrityWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CelebrityWalletTransaction" ADD CONSTRAINT "CelebrityWalletTransaction_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "CelebrityBooking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CelebrityWalletTransaction" ADD CONSTRAINT "CelebrityWalletTransaction_buyer_profile_id_fkey" FOREIGN KEY ("buyer_profile_id") REFERENCES "CelebrityBuyerProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CelebrityWalletTransaction" ADD CONSTRAINT "CelebrityWalletTransaction_celebrity_profile_id_fkey" FOREIGN KEY ("celebrity_profile_id") REFERENCES "CelebrityProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CelebrityWithdrawalRequest" ADD CONSTRAINT "CelebrityWithdrawalRequest_celebrity_profile_id_fkey" FOREIGN KEY ("celebrity_profile_id") REFERENCES "CelebrityProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CelebrityWithdrawalRequest" ADD CONSTRAINT "CelebrityWithdrawalRequest_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "CelebrityWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
