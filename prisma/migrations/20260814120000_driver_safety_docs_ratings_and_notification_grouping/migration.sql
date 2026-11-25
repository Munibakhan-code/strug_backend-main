-- Backfills the migration for schema.prisma changes that landed without one.
--
-- PR #1140 (driver safety/docs/ratings) added five models plus active_trip.share_token
-- and never shipped SQL. Separately, notification.group_actors/group_count/priority were
-- reconciled into schema.prisma from a live DB by a migration
-- (20260801084507_add_notification_priority_and_grouping) that was never committed to this
-- repo. Net effect on staging right now: notification.findMany P2022s and
-- notification.create outright fails, so no notification can be read or written.
--
-- Every statement is guarded. The notification columns and their index may already exist on
-- some environments (that is exactly how the drift arose), and an unguarded ADD COLUMN there
-- would abort the migration and jam the history with P3009 — which on this table is the
-- outage this file exists to end.

-- AlterTable: active_trip
ALTER TABLE "active_trip" ADD COLUMN IF NOT EXISTS "share_token" TEXT;
ALTER TABLE "active_trip" ADD COLUMN IF NOT EXISTS "share_token_created_at" TIMESTAMP(6);

-- AlterTable: notification
ALTER TABLE "notification" ADD COLUMN IF NOT EXISTS "group_actors" JSONB;
ALTER TABLE "notification" ADD COLUMN IF NOT EXISTS "group_count" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "notification" ADD COLUMN IF NOT EXISTS "priority" VARCHAR(10) NOT NULL DEFAULT 'medium';

-- CreateTable
CREATE TABLE IF NOT EXISTS "trip_sos_incident" (
    "incident_id" SERIAL NOT NULL,
    "trip_id" INTEGER NOT NULL,
    "triggered_by" INTEGER NOT NULL,
    "driver_lat" DOUBLE PRECISION,
    "driver_long" DOUBLE PRECISION,
    "contact_name" VARCHAR(120),
    "contact_phone" VARCHAR(30),
    "status" VARCHAR(20) NOT NULL DEFAULT 'open',
    "resolved_at" TIMESTAMP(3),
    "resolved_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_sos_incident_pkey" PRIMARY KEY ("incident_id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "driver_emergency_contact" (
    "driver_profile_id" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "phone" VARCHAR(30) NOT NULL,
    "relationship" VARCHAR(60),
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_emergency_contact_pkey" PRIMARY KEY ("driver_profile_id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "driver_document" (
    "document_id" SERIAL NOT NULL,
    "driver_profile_id" INTEGER NOT NULL,
    "doc_type" VARCHAR(24) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'unsubmitted',
    "document_url" TEXT NOT NULL,
    "document_name" VARCHAR(255),
    "expiry_date" DATE,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_at" TIMESTAMP(3),
    "reviewed_by" INTEGER,
    "rejection_reason" TEXT,

    CONSTRAINT "driver_document_pkey" PRIMARY KEY ("document_id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "trip_rider_rating" (
    "rating_id" SERIAL NOT NULL,
    "trip_id" INTEGER NOT NULL,
    "rider_id" INTEGER NOT NULL,
    "rating" INTEGER NOT NULL,
    "review" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_rider_rating_pkey" PRIMARY KEY ("rating_id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_trip_sos_incident_status" ON "trip_sos_incident"("status", "created_at");
CREATE INDEX IF NOT EXISTS "idx_trip_sos_incident_trip" ON "trip_sos_incident"("trip_id");
CREATE INDEX IF NOT EXISTS "driver_document_status_idx" ON "driver_document"("status");
CREATE UNIQUE INDEX IF NOT EXISTS "driver_document_driver_profile_id_doc_type_key" ON "driver_document"("driver_profile_id", "doc_type");
CREATE UNIQUE INDEX IF NOT EXISTS "trip_rider_rating_trip_id_key" ON "trip_rider_rating"("trip_id");
CREATE INDEX IF NOT EXISTS "trip_rider_rating_rider_id_idx" ON "trip_rider_rating"("rider_id");
CREATE UNIQUE INDEX IF NOT EXISTS "active_trip_share_token_key" ON "active_trip"("share_token");
CREATE INDEX IF NOT EXISTS "idx_notification_merge_lookup" ON "notification"("user_id", "vertical", "type", "created_at");

-- AddForeignKey
-- ADD CONSTRAINT has no IF NOT EXISTS in Postgres, so each is guarded on pg_constraint.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trip_sos_incident_trip_id_fkey') THEN
    ALTER TABLE "trip_sos_incident" ADD CONSTRAINT "trip_sos_incident_trip_id_fkey"
      FOREIGN KEY ("trip_id") REFERENCES "active_trip"("trip_id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'driver_emergency_contact_driver_profile_id_fkey') THEN
    ALTER TABLE "driver_emergency_contact" ADD CONSTRAINT "driver_emergency_contact_driver_profile_id_fkey"
      FOREIGN KEY ("driver_profile_id") REFERENCES "driver_profile"("driver_profile_id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'driver_document_driver_profile_id_fkey') THEN
    ALTER TABLE "driver_document" ADD CONSTRAINT "driver_document_driver_profile_id_fkey"
      FOREIGN KEY ("driver_profile_id") REFERENCES "driver_profile"("driver_profile_id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trip_rider_rating_trip_id_fkey') THEN
    ALTER TABLE "trip_rider_rating" ADD CONSTRAINT "trip_rider_rating_trip_id_fkey"
      FOREIGN KEY ("trip_id") REFERENCES "active_trip"("trip_id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trip_rider_rating_rider_id_fkey') THEN
    ALTER TABLE "trip_rider_rating" ADD CONSTRAINT "trip_rider_rating_rider_id_fkey"
      FOREIGN KEY ("rider_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;
