-- Repairs staging, no-op everywhere else.
--
-- 20260814120000_driver_safety_docs_ratings_and_notification_grouping is recorded in
-- staging's _prisma_migrations as applied, but its SQL never ran: `migrate status` reports
-- "Database schema is up to date" while notification.group_actors/group_count/priority and
-- active_trip.share_token are all absent from the table. That is the signature of a
-- `migrate resolve --applied`, which stamps the row without executing anything. Because the
-- row is recorded as a success rather than a failure, `migrate resolve --rolled-back`
-- refuses it, so the backlog cannot be re-driven through the existing unjam workflow.
--
-- Symptom this ends: any bare notification.findMany P2022s, so GET /notifications 500s for
-- every user on staging, and GET /driver-profile/me 500s too because it includes active_trip.
-- Confirmed same-database (a later migration, 20260820140000_townhall_x_import, IS applied
-- and its columns are served), so this is one skipped migration, not a stale replica.
--
-- The statements below are copied verbatim from that migration. Every one is IF NOT EXISTS
-- or guarded on pg_constraint, so on production - which already has all of this - the whole
-- file is a no-op, and re-running it cannot jam the history with P3009.

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
