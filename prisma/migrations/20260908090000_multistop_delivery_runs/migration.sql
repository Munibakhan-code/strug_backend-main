CREATE TABLE IF NOT EXISTS "ride_stop" (
  "ride_stop_id" SERIAL PRIMARY KEY,
  "ride_request_id" INTEGER NOT NULL,
  "sequence" INTEGER NOT NULL,
  "address" TEXT NOT NULL,
  "lat" DOUBLE PRECISION,
  "lng" DOUBLE PRECISION,
  "status" VARCHAR(24) NOT NULL DEFAULT 'pending',
  "added_by_user_id" INTEGER,
  "driver_approved_at" TIMESTAMP(6),
  "arrived_at" TIMESTAMP(6),
  "completed_at" TIMESTAMP(6),
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6),
  CONSTRAINT "ride_stop_ride_request_id_fkey"
    FOREIGN KEY ("ride_request_id") REFERENCES "ride_request"("ride_request_id")
    ON DELETE CASCADE ON UPDATE NO ACTION
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_ride_stop_sequence'
  ) THEN
    ALTER TABLE "ride_stop"
      ADD CONSTRAINT "uq_ride_stop_sequence" UNIQUE ("ride_request_id", "sequence");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_ride_stop_ride_status"
  ON "ride_stop" ("ride_request_id", "status");

ALTER TABLE "courier_order"
  ADD COLUMN IF NOT EXISTS "batch_id" INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'courier_order_batch_id_fkey'
  ) THEN
    ALTER TABLE "courier_order"
      ADD CONSTRAINT "courier_order_batch_id_fkey"
      FOREIGN KEY ("batch_id") REFERENCES "delivery_batch"("batch_id")
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_courier_order_batch"
  ON "courier_order" ("batch_id");

CREATE TABLE IF NOT EXISTS "ride_stop_change" (
  "ride_stop_change_id" SERIAL PRIMARY KEY,
  "ride_request_id" INTEGER NOT NULL,
  "requested_by_user_id" INTEGER NOT NULL,
  "driver_profile_id" INTEGER,
  "status" VARCHAR(24) NOT NULL DEFAULT 'pending',
  "current_stops" JSONB,
  "requested_stops" JSONB NOT NULL,
  "previous_estimated_fare" DOUBLE PRECISION,
  "new_estimated_fare" DOUBLE PRECISION,
  "fare_delta" DOUBLE PRECISION,
  "rejection_reason" VARCHAR(255),
  "decided_at" TIMESTAMP(6),
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6),
  CONSTRAINT "ride_stop_change_ride_request_id_fkey"
    FOREIGN KEY ("ride_request_id") REFERENCES "ride_request"("ride_request_id")
    ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX IF NOT EXISTS "idx_ride_stop_change_ride_status"
  ON "ride_stop_change" ("ride_request_id", "status");

ALTER TABLE "delivery_batch"
  ADD COLUMN IF NOT EXISTS "earnings_breakdown" JSONB,
  ADD COLUMN IF NOT EXISTS "eta_by_order" JSONB;

CREATE TABLE IF NOT EXISTS "delivery_run_offer" (
  "delivery_run_offer_id" SERIAL PRIMARY KEY,
  "batch_id" INTEGER NOT NULL,
  "order_type" VARCHAR(40) NOT NULL,
  "order_id" INTEGER NOT NULL,
  "driver_profile_id" INTEGER NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'pending',
  "incremental_distance_km" DOUBLE PRECISION,
  "incremental_duration_min" INTEGER,
  "incremental_payout" DOUBLE PRECISION,
  "compatibility" JSONB,
  "rejection_reason" VARCHAR(255),
  "expires_at" TIMESTAMP(6),
  "decided_at" TIMESTAMP(6),
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6),
  CONSTRAINT "delivery_run_offer_batch_id_fkey"
    FOREIGN KEY ("batch_id") REFERENCES "delivery_batch"("batch_id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "delivery_run_offer_driver_profile_id_fkey"
    FOREIGN KEY ("driver_profile_id") REFERENCES "driver_profile"("driver_profile_id")
    ON DELETE CASCADE ON UPDATE NO ACTION
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_delivery_run_offer_order'
  ) THEN
    ALTER TABLE "delivery_run_offer"
      ADD CONSTRAINT "uq_delivery_run_offer_order" UNIQUE ("batch_id", "order_type", "order_id");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_delivery_run_offer_driver_status"
  ON "delivery_run_offer" ("driver_profile_id", "status");

CREATE INDEX IF NOT EXISTS "idx_delivery_run_offer_batch_status"
  ON "delivery_run_offer" ("batch_id", "status");
