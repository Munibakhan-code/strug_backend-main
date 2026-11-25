-- Authenticity: unpublished-by-default + property report queue + capability status index
ALTER TABLE "property" ALTER COLUMN "is_published" SET DEFAULT false;

CREATE INDEX IF NOT EXISTS "idx_seller_capability_status" ON "seller_capability"("status");

CREATE TABLE IF NOT EXISTS "property_report" (
    "report_id" SERIAL NOT NULL,
    "property_id" INTEGER NOT NULL,
    "reporter_id" INTEGER NOT NULL,
    "reason" VARCHAR(80) NOT NULL,
    "details" TEXT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),

    CONSTRAINT "property_report_pkey" PRIMARY KEY ("report_id")
);

CREATE INDEX IF NOT EXISTS "idx_property_report_status" ON "property_report"("status");
CREATE INDEX IF NOT EXISTS "idx_property_report_property" ON "property_report"("property_id");
CREATE INDEX IF NOT EXISTS "idx_property_report_reporter" ON "property_report"("reporter_id");

DO $$ BEGIN
  ALTER TABLE "property_report" ADD CONSTRAINT "property_report_property_id_fkey"
    FOREIGN KEY ("property_id") REFERENCES "property"("property_id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "property_report" ADD CONSTRAINT "property_report_reporter_id_fkey"
    FOREIGN KEY ("reporter_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
