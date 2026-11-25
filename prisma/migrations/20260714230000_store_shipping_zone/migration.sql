-- Seller shipping zones for hybrid local delivery vs ship-by-seller quotes.
CREATE TABLE IF NOT EXISTS "store_shipping_zone" (
    "zone_id" SERIAL PRIMARY KEY,
    "store_id" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "match_type" VARCHAR(20) NOT NULL DEFAULT 'country',
    "country" VARCHAR(120) NOT NULL,
    "city" VARCHAR(120),
    "fee" DOUBLE PRECISION NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "store_shipping_zone_store_id_fkey"
      FOREIGN KEY ("store_id") REFERENCES "store_profile"("store_id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_store_shipping_zone_store" ON "store_shipping_zone"("store_id");
CREATE INDEX IF NOT EXISTS "idx_store_shipping_zone_country" ON "store_shipping_zone"("store_id", "country");
