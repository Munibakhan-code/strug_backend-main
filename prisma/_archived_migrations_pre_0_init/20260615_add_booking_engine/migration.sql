-- Shared Booking Engine — additive, idempotent.
-- Generic Airbnb-style booking core over 12 verticals (tempstay, hotel, venue,
-- equipment, vehicle, lesson, event, experience, celebrity, artist, reservation).
-- owner_id / guest_id / host_id / actor_id reference "user"(user_id) as plain
-- indexed integers (no FK) to avoid coupling to the large shared user table.
-- Safe to re-run: CREATE TABLE/INDEX IF NOT EXISTS.

-- ── booking_listing ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "booking_listing" (
    "booking_listing_id" SERIAL NOT NULL,
    "vertical" VARCHAR(40) NOT NULL,
    "owner_id" INTEGER NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "location" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "price" DOUBLE PRECISION,
    "price_unit" VARCHAR(20) NOT NULL DEFAULT 'night',
    "currency" VARCHAR(3) NOT NULL DEFAULT 'CAD',
    "instant_book" BOOLEAN NOT NULL DEFAULT false,
    "requires_deposit" BOOLEAN NOT NULL DEFAULT false,
    "deposit_amount" DOUBLE PRECISION,
    "fulfillment" VARCHAR(20) NOT NULL DEFAULT 'onsite',
    "capacity" INTEGER,
    "cleaning_fee" DOUBLE PRECISION DEFAULT 0,
    "service_fee_pct" DOUBLE PRECISION DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "attributes" JSONB,
    "images" JSONB,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),
    CONSTRAINT "booking_listing_pkey" PRIMARY KEY ("booking_listing_id")
);
CREATE INDEX IF NOT EXISTS "idx_booking_listing_vertical" ON "booking_listing"("vertical");
CREATE INDEX IF NOT EXISTS "idx_booking_listing_owner" ON "booking_listing"("owner_id");

-- ── availability ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "availability" (
    "availability_id" SERIAL NOT NULL,
    "booking_listing_id" INTEGER NOT NULL,
    "date" DATE,
    "time_from" VARCHAR(5),
    "time_to" VARCHAR(5),
    "is_blocked" BOOLEAN NOT NULL DEFAULT false,
    "price_override" DOUBLE PRECISION,
    "capacity_override" INTEGER,
    CONSTRAINT "availability_pkey" PRIMARY KEY ("availability_id"),
    CONSTRAINT "availability_listing_fkey" FOREIGN KEY ("booking_listing_id") REFERENCES "booking_listing"("booking_listing_id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX IF NOT EXISTS "idx_availability_listing_date" ON "availability"("booking_listing_id", "date");

-- ── booking ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "booking" (
    "booking_id" SERIAL NOT NULL,
    "booking_listing_id" INTEGER NOT NULL,
    "vertical" VARCHAR(40) NOT NULL,
    "guest_id" INTEGER NOT NULL,
    "host_id" INTEGER NOT NULL,
    "start_date" DATE,
    "end_date" DATE,
    "start_time" VARCHAR(5),
    "end_time" VARCHAR(5),
    "unit_count" INTEGER,
    "guests" INTEGER DEFAULT 1,
    "subtotal" DOUBLE PRECISION,
    "cleaning_fee" DOUBLE PRECISION DEFAULT 0,
    "service_fee" DOUBLE PRECISION DEFAULT 0,
    "deposit" DOUBLE PRECISION DEFAULT 0,
    "total" DOUBLE PRECISION,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'CAD',
    "status" VARCHAR(20) NOT NULL DEFAULT 'requested',
    "payment_status" VARCHAR(20) NOT NULL DEFAULT 'unpaid',
    "payment_method" VARCHAR(40),
    "payment_intent_id" VARCHAR(255),
    "refund_status" VARCHAR(20) NOT NULL DEFAULT 'none',
    "refund_amount" DOUBLE PRECISION DEFAULT 0,
    "cancellation_reason" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),
    CONSTRAINT "booking_pkey" PRIMARY KEY ("booking_id"),
    CONSTRAINT "booking_listing_fkey" FOREIGN KEY ("booking_listing_id") REFERENCES "booking_listing"("booking_listing_id") ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE INDEX IF NOT EXISTS "idx_booking_listing" ON "booking"("booking_listing_id");
CREATE INDEX IF NOT EXISTS "idx_booking_guest" ON "booking"("guest_id");
CREATE INDEX IF NOT EXISTS "idx_booking_host" ON "booking"("host_id");
CREATE INDEX IF NOT EXISTS "idx_booking_vertical" ON "booking"("vertical");

-- ── booking_event (lifecycle audit log) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS "booking_event" (
    "booking_event_id" SERIAL NOT NULL,
    "booking_id" INTEGER NOT NULL,
    "event_type" VARCHAR(40) NOT NULL,
    "actor_id" INTEGER,
    "from_status" VARCHAR(20),
    "to_status" VARCHAR(20),
    "metadata" JSONB,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "booking_event_pkey" PRIMARY KEY ("booking_event_id"),
    CONSTRAINT "booking_event_booking_fkey" FOREIGN KEY ("booking_id") REFERENCES "booking"("booking_id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX IF NOT EXISTS "idx_booking_event_booking" ON "booking_event"("booking_id");
