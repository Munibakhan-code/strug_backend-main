-- Insurance & Mortgage Quote Marketplace (M5) — additive, idempotent.
-- Provider availability calendar + link an appointment to a chosen slot.

CREATE TABLE IF NOT EXISTS "quote_provider_availability" (
    "quote_provider_availability_id" SERIAL NOT NULL,
    "quote_provider_id" INTEGER NOT NULL,
    "slot_start" TIMESTAMP(6) NOT NULL,
    "slot_end" TIMESTAMP(6),
    "is_booked" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "quote_provider_availability_pkey" PRIMARY KEY ("quote_provider_availability_id"),
    CONSTRAINT "quote_prov_avail_provider_fkey" FOREIGN KEY ("quote_provider_id") REFERENCES "quote_provider"("quote_provider_id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX IF NOT EXISTS "idx_quote_prov_avail" ON "quote_provider_availability"("quote_provider_id", "slot_start");

-- Link an appointment to the calendar slot it booked (nullable; propose-and-confirm leaves it null).
ALTER TABLE "quote_appointment" ADD COLUMN IF NOT EXISTS "availability_id" INTEGER;
