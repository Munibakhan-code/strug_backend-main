-- Creator rates + packages on Work (per leaf service), so Book Artist talent
-- can set pricing on the same worker profiles hirers browse.

ALTER TABLE "worker_category"
  ADD COLUMN IF NOT EXISTS "price_type" VARCHAR(10) DEFAULT 'hourly',
  ADD COLUMN IF NOT EXISTS "hourly_rate" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "flat_rate" DOUBLE PRECISION;

CREATE TABLE IF NOT EXISTS "worker_package" (
  "worker_package_id" SERIAL PRIMARY KEY,
  "worker_category_id" INTEGER NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "price" DOUBLE PRECISION NOT NULL,
  "duration_hours" DOUBLE PRECISION NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "worker_package_category_fkey"
    FOREIGN KEY ("worker_category_id") REFERENCES "worker_category"("worker_category_id")
    ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX IF NOT EXISTS "idx_worker_package_category"
  ON "worker_package"("worker_category_id");
