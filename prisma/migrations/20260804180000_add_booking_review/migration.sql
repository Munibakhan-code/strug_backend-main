-- Guest reviews for shared booking-engine stays (hotel, tempstay, venue, …).
-- One review per booking; denormalized avg_rating / review_count on listing.

ALTER TABLE "booking_listing"
  ADD COLUMN IF NOT EXISTS "avg_rating" DOUBLE PRECISION DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "review_count" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "booking_review" (
    "booking_review_id"  SERIAL NOT NULL,
    "booking_id"         INTEGER NOT NULL,
    "booking_listing_id" INTEGER NOT NULL,
    "user_id"            INTEGER NOT NULL,
    "rating"             INTEGER NOT NULL,
    "review"             TEXT,
    "created_at"         TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_review_pkey" PRIMARY KEY ("booking_review_id")
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_booking_review_booking'
    ) THEN
        ALTER TABLE "booking_review"
            ADD CONSTRAINT "uq_booking_review_booking"
            UNIQUE ("booking_id");
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'booking_review_booking_fkey'
    ) THEN
        ALTER TABLE "booking_review"
            ADD CONSTRAINT "booking_review_booking_fkey"
            FOREIGN KEY ("booking_id") REFERENCES "booking"("booking_id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'booking_review_listing_fkey'
    ) THEN
        ALTER TABLE "booking_review"
            ADD CONSTRAINT "booking_review_listing_fkey"
            FOREIGN KEY ("booking_listing_id") REFERENCES "booking_listing"("booking_listing_id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'booking_review_user_fkey'
    ) THEN
        ALTER TABLE "booking_review"
            ADD CONSTRAINT "booking_review_user_fkey"
            FOREIGN KEY ("user_id") REFERENCES "user"("user_id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_booking_review_listing" ON "booking_review"("booking_listing_id");
CREATE INDEX IF NOT EXISTS "idx_booking_review_user" ON "booking_review"("user_id");
