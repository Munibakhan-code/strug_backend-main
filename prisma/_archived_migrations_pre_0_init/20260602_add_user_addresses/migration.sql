-- Multi-address book: a user can save multiple named addresses (Home, Work, ...).
-- The default address still mirrors into user.saved_address/lat/long for platform-wide use.
CREATE TABLE IF NOT EXISTS "user_address" (
    "address_id" SERIAL PRIMARY KEY,
    "user_id"    INTEGER NOT NULL,
    "label"      VARCHAR(60) NOT NULL,
    "street"     VARCHAR(255) NOT NULL,
    "city"       VARCHAR(120),
    "country"    VARCHAR(120),
    "lat"        DOUBLE PRECISION,
    "lng"        DOUBLE PRECISION,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_address_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "user_address_user_id_idx" ON "user_address"("user_id");
