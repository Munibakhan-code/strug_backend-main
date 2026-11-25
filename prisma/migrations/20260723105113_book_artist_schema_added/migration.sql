-- CreateEnum
CREATE TYPE "ArtistStatus" AS ENUM ('APPROVED', 'PENDING', 'REJECTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "ArtistListingStatus" AS ENUM ('ACTIVE', 'PAUSED', 'DRAFT', 'DELETED');

-- CreateEnum
CREATE TYPE "ArtistBookingStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ArtistPaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "ArtistWalletTransactionType" AS ENUM ('BOOKING', 'WITHDRAWAL');

-- CreateEnum
CREATE TYPE "ArtistWalletTransactionStatus" AS ENUM ('PENDING', 'AVAILABLE', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ArtistWithdrawalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'PAID');

-- AlterTable
ALTER TABLE "social_highlight" ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ArtistBuyerProfile" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArtistBuyerProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArtistProfile" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "display_name" VARCHAR(255) NOT NULL,
    "artist_bio" TEXT,
    "tagline" VARCHAR(255),
    "country" VARCHAR(100),
    "city" VARCHAR(100),
    "languages" TEXT[],
    "genres" TEXT[],
    "profile_image" TEXT,
    "cover_image" TEXT,
    "rating" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_reviews" INTEGER NOT NULL DEFAULT 0,
    "total_bookings" INTEGER NOT NULL DEFAULT 0,
    "status" "ArtistStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArtistProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArtistListing" (
    "id" SERIAL NOT NULL,
    "artist_profile_id" INTEGER NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT NOT NULL,
    "category" VARCHAR(100) NOT NULL,
    "genre" VARCHAR(100) NOT NULL,
    "location" VARCHAR(255),
    "instant_book" BOOLEAN NOT NULL DEFAULT false,
    "requires_deposit" BOOLEAN NOT NULL DEFAULT false,
    "deposit_amount" DECIMAL(12,2),
    "cleaning_fee" DECIMAL(12,2),
    "service_fee_pct" DECIMAL(5,2),
    "images" JSONB NOT NULL,
    "status" "ArtistListingStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArtistListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArtistPackage" (
    "id" SERIAL NOT NULL,
    "artist_listing_id" INTEGER NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "duration_minutes" INTEGER NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArtistPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArtistBooking" (
    "id" SERIAL NOT NULL,
    "buyer_profile_id" INTEGER NOT NULL,
    "artist_profile_id" INTEGER NOT NULL,
    "artist_listing_id" INTEGER NOT NULL,
    "package_id" INTEGER NOT NULL,
    "event_name" VARCHAR(255),
    "event_date" TIMESTAMP(3) NOT NULL,
    "event_time" VARCHAR(50),
    "expected_guests" INTEGER,
    "event_location" TEXT NOT NULL,
    "notes" TEXT,
    "referral_code" VARCHAR(100),
    "price" DECIMAL(12,2) NOT NULL,
    "payment_status" "ArtistPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "status" "ArtistBookingStatus" NOT NULL DEFAULT 'PENDING',
    "stripe_payment_intent_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "ArtistBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArtistReview" (
    "id" SERIAL NOT NULL,
    "booking_id" INTEGER NOT NULL,
    "listing_id" INTEGER NOT NULL,
    "buyer_profile_id" INTEGER NOT NULL,
    "artist_profile_id" INTEGER NOT NULL,
    "rating" INTEGER NOT NULL,
    "review" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArtistReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArtistWallet" (
    "id" SERIAL NOT NULL,
    "artist_profile_id" INTEGER NOT NULL,
    "pending_balance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "available_balance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_earned" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_withdrawn" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArtistWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArtistWalletTransaction" (
    "id" SERIAL NOT NULL,
    "wallet_id" INTEGER NOT NULL,
    "booking_id" INTEGER,
    "buyer_profile_id" INTEGER,
    "artist_profile_id" INTEGER,
    "amount" DECIMAL(12,2) NOT NULL,
    "type" "ArtistWalletTransactionType" NOT NULL,
    "status" "ArtistWalletTransactionStatus" NOT NULL DEFAULT 'PENDING',
    "available_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArtistWalletTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArtistWithdrawalRequest" (
    "id" SERIAL NOT NULL,
    "artist_profile_id" INTEGER NOT NULL,
    "wallet_id" INTEGER NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" VARCHAR(50) NOT NULL,
    "account_title" VARCHAR(150) NOT NULL,
    "account_number" VARCHAR(100) NOT NULL,
    "status" "ArtistWithdrawalStatus" NOT NULL DEFAULT 'PENDING',
    "admin_note" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArtistWithdrawalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ArtistBuyerProfile_user_id_key" ON "ArtistBuyerProfile"("user_id");

-- CreateIndex
CREATE INDEX "ArtistBuyerProfile_user_id_idx" ON "ArtistBuyerProfile"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "ArtistProfile_user_id_key" ON "ArtistProfile"("user_id");

-- CreateIndex
CREATE INDEX "ArtistProfile_user_id_idx" ON "ArtistProfile"("user_id");

-- CreateIndex
CREATE INDEX "ArtistProfile_status_idx" ON "ArtistProfile"("status");

-- CreateIndex
CREATE INDEX "ArtistListing_artist_profile_id_idx" ON "ArtistListing"("artist_profile_id");

-- CreateIndex
CREATE INDEX "ArtistListing_status_idx" ON "ArtistListing"("status");

-- CreateIndex
CREATE INDEX "ArtistListing_category_idx" ON "ArtistListing"("category");

-- CreateIndex
CREATE INDEX "ArtistListing_genre_idx" ON "ArtistListing"("genre");

-- CreateIndex
CREATE INDEX "ArtistPackage_artist_listing_id_idx" ON "ArtistPackage"("artist_listing_id");

-- CreateIndex
CREATE UNIQUE INDEX "ArtistBooking_stripe_payment_intent_id_key" ON "ArtistBooking"("stripe_payment_intent_id");

-- CreateIndex
CREATE INDEX "ArtistBooking_buyer_profile_id_idx" ON "ArtistBooking"("buyer_profile_id");

-- CreateIndex
CREATE INDEX "ArtistBooking_artist_profile_id_idx" ON "ArtistBooking"("artist_profile_id");

-- CreateIndex
CREATE INDEX "ArtistBooking_artist_listing_id_idx" ON "ArtistBooking"("artist_listing_id");

-- CreateIndex
CREATE INDEX "ArtistBooking_status_idx" ON "ArtistBooking"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ArtistReview_booking_id_key" ON "ArtistReview"("booking_id");

-- CreateIndex
CREATE INDEX "ArtistReview_artist_profile_id_idx" ON "ArtistReview"("artist_profile_id");

-- CreateIndex
CREATE INDEX "ArtistReview_buyer_profile_id_idx" ON "ArtistReview"("buyer_profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "ArtistWallet_artist_profile_id_key" ON "ArtistWallet"("artist_profile_id");

-- CreateIndex
CREATE INDEX "ArtistWallet_artist_profile_id_idx" ON "ArtistWallet"("artist_profile_id");

-- CreateIndex
CREATE INDEX "ArtistWalletTransaction_wallet_id_idx" ON "ArtistWalletTransaction"("wallet_id");

-- CreateIndex
CREATE INDEX "ArtistWalletTransaction_booking_id_idx" ON "ArtistWalletTransaction"("booking_id");

-- CreateIndex
CREATE INDEX "ArtistWalletTransaction_status_idx" ON "ArtistWalletTransaction"("status");

-- CreateIndex
CREATE INDEX "ArtistWithdrawalRequest_artist_profile_id_idx" ON "ArtistWithdrawalRequest"("artist_profile_id");

-- CreateIndex
CREATE INDEX "ArtistWithdrawalRequest_wallet_id_idx" ON "ArtistWithdrawalRequest"("wallet_id");

-- CreateIndex
CREATE INDEX "ArtistWithdrawalRequest_status_idx" ON "ArtistWithdrawalRequest"("status");

-- NOTE: 4 unrelated drift indexes (subscription_channel_id_created_at_idx,
-- video_title_idx, video_comments_video_id_created_at_idx,
-- video_likes_video_id_is_like_created_at_idx) were removed from this migration.
-- video_title_idx used `gin_trgm_ops`, but pg_trgm is NOT on prod Azure Postgres
-- Flexible Server's extension allow-list, so a bare CREATE INDEX errors and rolls
-- back the whole migration (P3009) — jamming prod deploy and every later migration.
-- None of the four are declared in schema.prisma. If wanted, add them via a dedicated
-- migration using the DO/EXCEPTION guard from 20260707_search_and_feed_perf_indexes.

-- AddForeignKey
ALTER TABLE "ArtistBuyerProfile" ADD CONSTRAINT "ArtistBuyerProfile_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtistProfile" ADD CONSTRAINT "ArtistProfile_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtistListing" ADD CONSTRAINT "ArtistListing_artist_profile_id_fkey" FOREIGN KEY ("artist_profile_id") REFERENCES "ArtistProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtistPackage" ADD CONSTRAINT "ArtistPackage_artist_listing_id_fkey" FOREIGN KEY ("artist_listing_id") REFERENCES "ArtistListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtistBooking" ADD CONSTRAINT "ArtistBooking_buyer_profile_id_fkey" FOREIGN KEY ("buyer_profile_id") REFERENCES "ArtistBuyerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtistBooking" ADD CONSTRAINT "ArtistBooking_artist_profile_id_fkey" FOREIGN KEY ("artist_profile_id") REFERENCES "ArtistProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtistBooking" ADD CONSTRAINT "ArtistBooking_artist_listing_id_fkey" FOREIGN KEY ("artist_listing_id") REFERENCES "ArtistListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtistBooking" ADD CONSTRAINT "ArtistBooking_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "ArtistPackage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtistReview" ADD CONSTRAINT "ArtistReview_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "ArtistBooking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtistReview" ADD CONSTRAINT "ArtistReview_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "ArtistListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtistReview" ADD CONSTRAINT "ArtistReview_buyer_profile_id_fkey" FOREIGN KEY ("buyer_profile_id") REFERENCES "ArtistBuyerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtistReview" ADD CONSTRAINT "ArtistReview_artist_profile_id_fkey" FOREIGN KEY ("artist_profile_id") REFERENCES "ArtistProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtistWallet" ADD CONSTRAINT "ArtistWallet_artist_profile_id_fkey" FOREIGN KEY ("artist_profile_id") REFERENCES "ArtistProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtistWalletTransaction" ADD CONSTRAINT "ArtistWalletTransaction_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "ArtistWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtistWalletTransaction" ADD CONSTRAINT "ArtistWalletTransaction_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "ArtistBooking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtistWalletTransaction" ADD CONSTRAINT "ArtistWalletTransaction_buyer_profile_id_fkey" FOREIGN KEY ("buyer_profile_id") REFERENCES "ArtistBuyerProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtistWalletTransaction" ADD CONSTRAINT "ArtistWalletTransaction_artist_profile_id_fkey" FOREIGN KEY ("artist_profile_id") REFERENCES "ArtistProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtistWithdrawalRequest" ADD CONSTRAINT "ArtistWithdrawalRequest_artist_profile_id_fkey" FOREIGN KEY ("artist_profile_id") REFERENCES "ArtistProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtistWithdrawalRequest" ADD CONSTRAINT "ArtistWithdrawalRequest_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "ArtistWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
