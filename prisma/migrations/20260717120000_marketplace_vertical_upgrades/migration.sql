-- Marketplace vertical upgrades: property enrichment, hotel rooms, restaurant bookings

-- ── property enrichment ─────────────────────────────────────────────────────
ALTER TABLE "property"
  ADD COLUMN IF NOT EXISTS "city" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "neighborhood" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "province" VARCHAR(80),
  ADD COLUMN IF NOT EXISTS "country" VARCHAR(80),
  ADD COLUMN IF NOT EXISTS "postal_code" VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "latitude" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "longitude" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "price_min" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "price_max" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "beds_min" INTEGER,
  ADD COLUMN IF NOT EXISTS "beds_max" INTEGER,
  ADD COLUMN IF NOT EXISTS "baths_min" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "baths_max" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "sqft_min" INTEGER,
  ADD COLUMN IF NOT EXISTS "sqft_max" INTEGER,
  ADD COLUMN IF NOT EXISTS "total_units" INTEGER,
  ADD COLUMN IF NOT EXISTS "listing_status" VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "construction_status" VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "completion_date" VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "sales_start" VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "deposit_info" TEXT,
  ADD COLUMN IF NOT EXISTS "maintenance_fee" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "developer_name" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "builder_website" VARCHAR(500),
  ADD COLUMN IF NOT EXISTS "virtual_tour_url" VARCHAR(1000),
  ADD COLUMN IF NOT EXISTS "video_url" VARCHAR(1000),
  ADD COLUMN IF NOT EXISTS "sales_center_address" TEXT,
  ADD COLUMN IF NOT EXISTS "sales_center_phone" VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "sales_center_email" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "sales_center_hours" JSONB,
  ADD COLUMN IF NOT EXISTS "amenities" JSONB,
  ADD COLUMN IF NOT EXISTS "highlights" JSONB,
  ADD COLUMN IF NOT EXISTS "is_featured" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "is_verified" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "is_published" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "view_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(6);

CREATE INDEX IF NOT EXISTS "idx_property_vertical" ON "property"("vertical");
CREATE INDEX IF NOT EXISTS "idx_property_user" ON "property"("user_id");
CREATE INDEX IF NOT EXISTS "idx_property_city" ON "property"("city");
CREATE INDEX IF NOT EXISTS "idx_property_published" ON "property"("is_published");
CREATE INDEX IF NOT EXISTS "idx_property_listing_status" ON "property"("listing_status");

-- Backfill listing_status from legacy status where possible
UPDATE "property"
SET "listing_status" = COALESCE("listing_status", "status")
WHERE "listing_status" IS NULL AND "status" IS NOT NULL;

-- ── food_vendor reservation fields ──────────────────────────────────────────
ALTER TABLE "food_vendor"
  ADD COLUMN IF NOT EXISTS "description" TEXT,
  ADD COLUMN IF NOT EXISTS "price_level" VARCHAR(10),
  ADD COLUMN IF NOT EXISTS "accepts_reservations" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "reservation_duration_min" INTEGER NOT NULL DEFAULT 90,
  ADD COLUMN IF NOT EXISTS "reservation_buffer_min" INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS "max_party_size" INTEGER NOT NULL DEFAULT 12,
  ADD COLUMN IF NOT EXISTS "min_party_size" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "reservation_hours" JSONB,
  ADD COLUMN IF NOT EXISTS "weekly_hours" JSONB,
  ADD COLUMN IF NOT EXISTS "gallery" JSONB,
  ADD COLUMN IF NOT EXISTS "reservation_policy" TEXT;

CREATE INDEX IF NOT EXISTS "idx_food_vendor_reservations" ON "food_vendor"("accepts_reservations");

-- ── reservation enrichment ──────────────────────────────────────────────────
ALTER TABLE "reservation"
  ADD COLUMN IF NOT EXISTS "seating_area_id" INTEGER,
  ADD COLUMN IF NOT EXISTS "table_id" INTEGER,
  ADD COLUMN IF NOT EXISTS "duration_min" INTEGER DEFAULT 90,
  ADD COLUMN IF NOT EXISTS "guest_name" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "guest_phone" VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "guest_email" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "idx_reservation_datetime" ON "reservation"("date", "time");
CREATE INDEX IF NOT EXISTS "idx_reservation_status" ON "reservation"("status");

-- ── booking room_type_id ────────────────────────────────────────────────────
ALTER TABLE "booking"
  ADD COLUMN IF NOT EXISTS "room_type_id" INTEGER;

CREATE INDEX IF NOT EXISTS "idx_booking_room_type" ON "booking"("room_type_id");

-- ── property child tables ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "property_image" (
  "image_id" SERIAL PRIMARY KEY,
  "property_id" INTEGER NOT NULL,
  "url" VARCHAR(1000) NOT NULL,
  "caption" VARCHAR(255),
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "is_cover" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "property_image_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "property"("property_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_property_image_property" ON "property_image"("property_id");

CREATE TABLE IF NOT EXISTS "property_floor_plan" (
  "floor_plan_id" SERIAL PRIMARY KEY,
  "property_id" INTEGER NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "beds" DOUBLE PRECISION,
  "baths" DOUBLE PRECISION,
  "sqft_min" INTEGER,
  "sqft_max" INTEGER,
  "price_min" DOUBLE PRECISION,
  "price_max" DOUBLE PRECISION,
  "availability" VARCHAR(40),
  "image_url" VARCHAR(1000),
  "description" TEXT,
  "unit_count" INTEGER,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6),
  CONSTRAINT "property_floor_plan_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "property"("property_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_property_floor_plan_property" ON "property_floor_plan"("property_id");

CREATE TABLE IF NOT EXISTS "property_update" (
  "update_id" SERIAL PRIMARY KEY,
  "property_id" INTEGER NOT NULL,
  "title" VARCHAR(255) NOT NULL,
  "body" TEXT,
  "image_url" VARCHAR(1000),
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "property_update_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "property"("property_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_property_update_property" ON "property_update"("property_id");

CREATE TABLE IF NOT EXISTS "property_inquiry" (
  "inquiry_id" SERIAL PRIMARY KEY,
  "property_id" INTEGER NOT NULL,
  "user_id" INTEGER NOT NULL,
  "floor_plan_id" INTEGER,
  "type" VARCHAR(40),
  "name" VARCHAR(255),
  "email" VARCHAR(255),
  "phone" VARCHAR(40),
  "message" TEXT,
  "status" VARCHAR(20) NOT NULL DEFAULT 'new',
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6),
  CONSTRAINT "property_inquiry_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "property"("property_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "property_inquiry_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_property_inquiry_property" ON "property_inquiry"("property_id");
CREATE INDEX IF NOT EXISTS "idx_property_inquiry_user" ON "property_inquiry"("user_id");
CREATE INDEX IF NOT EXISTS "idx_property_inquiry_status" ON "property_inquiry"("status");

CREATE TABLE IF NOT EXISTS "property_viewing" (
  "viewing_id" SERIAL PRIMARY KEY,
  "property_id" INTEGER NOT NULL,
  "user_id" INTEGER NOT NULL,
  "viewing_date" TIMESTAMP(6),
  "note" TEXT,
  "status" VARCHAR(20) NOT NULL DEFAULT 'requested',
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6),
  CONSTRAINT "property_viewing_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "property"("property_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "property_viewing_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_property_viewing_property" ON "property_viewing"("property_id");
CREATE INDEX IF NOT EXISTS "idx_property_viewing_user" ON "property_viewing"("user_id");
CREATE INDEX IF NOT EXISTS "idx_property_viewing_status" ON "property_viewing"("status");

CREATE TABLE IF NOT EXISTS "property_save" (
  "save_id" SERIAL PRIMARY KEY,
  "property_id" INTEGER NOT NULL,
  "user_id" INTEGER NOT NULL,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "property_save_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "property"("property_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "property_save_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "property_save_property_id_user_id_key" ON "property_save"("property_id", "user_id");
CREATE INDEX IF NOT EXISTS "idx_property_save_user" ON "property_save"("user_id");

CREATE TABLE IF NOT EXISTS "property_follow" (
  "follow_id" SERIAL PRIMARY KEY,
  "property_id" INTEGER NOT NULL,
  "user_id" INTEGER NOT NULL,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "property_follow_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "property"("property_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "property_follow_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "property_follow_property_id_user_id_key" ON "property_follow"("property_id", "user_id");
CREATE INDEX IF NOT EXISTS "idx_property_follow_user" ON "property_follow"("user_id");

CREATE TABLE IF NOT EXISTS "property_saved_search" (
  "saved_search_id" SERIAL PRIMARY KEY,
  "user_id" INTEGER NOT NULL,
  "name" VARCHAR(120),
  "vertical" VARCHAR(40),
  "filters" JSONB NOT NULL,
  "alert_enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6),
  CONSTRAINT "property_saved_search_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_property_saved_search_user" ON "property_saved_search"("user_id");

CREATE TABLE IF NOT EXISTS "seller_capability" (
  "capability_id" SERIAL PRIMARY KEY,
  "user_id" INTEGER NOT NULL,
  "capability" VARCHAR(40) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'active',
  "metadata" JSONB,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6),
  CONSTRAINT "seller_capability_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "seller_capability_user_id_capability_key" ON "seller_capability"("user_id", "capability");
CREATE INDEX IF NOT EXISTS "idx_seller_capability_name" ON "seller_capability"("capability");

-- ── hotel room inventory ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "hotel_room_type" (
  "room_type_id" SERIAL PRIMARY KEY,
  "booking_listing_id" INTEGER NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "description" TEXT,
  "beds" VARCHAR(80),
  "bed_count" INTEGER,
  "max_guests" INTEGER NOT NULL DEFAULT 2,
  "size_sqm" DOUBLE PRECISION,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "nightly_price" DOUBLE PRECISION NOT NULL,
  "amenities" JSONB,
  "images" JSONB,
  "policies" TEXT,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6),
  CONSTRAINT "hotel_room_type_booking_listing_id_fkey" FOREIGN KEY ("booking_listing_id") REFERENCES "booking_listing"("booking_listing_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_hotel_room_type_listing" ON "hotel_room_type"("booking_listing_id");

CREATE TABLE IF NOT EXISTS "hotel_room_inventory" (
  "inventory_id" SERIAL PRIMARY KEY,
  "room_type_id" INTEGER NOT NULL,
  "date" DATE NOT NULL,
  "available" INTEGER,
  "price_override" DOUBLE PRECISION,
  "is_blocked" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "hotel_room_inventory_room_type_id_fkey" FOREIGN KEY ("room_type_id") REFERENCES "hotel_room_type"("room_type_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "hotel_room_inventory_room_type_id_date_key" ON "hotel_room_inventory"("room_type_id", "date");
CREATE INDEX IF NOT EXISTS "idx_hotel_room_inventory_date" ON "hotel_room_inventory"("date");

-- ── restaurant seating ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "restaurant_seating" (
  "seating_id" SERIAL PRIMARY KEY,
  "vendor_id" INTEGER NOT NULL,
  "name" VARCHAR(80) NOT NULL,
  "description" TEXT,
  "capacity" INTEGER,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "restaurant_seating_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "food_vendor"("vendor_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_restaurant_seating_vendor" ON "restaurant_seating"("vendor_id");

CREATE TABLE IF NOT EXISTS "restaurant_table" (
  "table_id" SERIAL PRIMARY KEY,
  "vendor_id" INTEGER NOT NULL,
  "seating_id" INTEGER,
  "name" VARCHAR(40) NOT NULL,
  "min_seats" INTEGER NOT NULL DEFAULT 1,
  "max_seats" INTEGER NOT NULL DEFAULT 4,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "restaurant_table_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "food_vendor"("vendor_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "restaurant_table_seating_id_fkey" FOREIGN KEY ("seating_id") REFERENCES "restaurant_seating"("seating_id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_restaurant_table_vendor" ON "restaurant_table"("vendor_id");
CREATE INDEX IF NOT EXISTS "idx_restaurant_table_seating" ON "restaurant_table"("seating_id");

-- FKs that depend on new tables
DO $$ BEGIN
  ALTER TABLE "reservation" ADD CONSTRAINT "reservation_seating_area_id_fkey"
    FOREIGN KEY ("seating_area_id") REFERENCES "restaurant_seating"("seating_id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "reservation" ADD CONSTRAINT "reservation_table_id_fkey"
    FOREIGN KEY ("table_id") REFERENCES "restaurant_table"("table_id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "booking" ADD CONSTRAINT "booking_room_type_id_fkey"
    FOREIGN KEY ("room_type_id") REFERENCES "hotel_room_type"("room_type_id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
