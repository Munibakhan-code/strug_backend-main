-- Additive: food_order_rating for post-pickup/delivery restaurant ratings.
-- One rating per order (mirrors ride_rating). Cascade when the order is deleted.

CREATE TABLE IF NOT EXISTS "food_order_rating" (
    "rating_id"     SERIAL NOT NULL,
    "food_order_id" INTEGER NOT NULL,
    "user_id"       INTEGER NOT NULL,
    "vendor_id"     INTEGER,
    "rating"        INTEGER NOT NULL,
    "review"        TEXT,
    "created_at"    TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "food_order_rating_pkey" PRIMARY KEY ("rating_id")
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_food_order_rating_order'
    ) THEN
        DROP INDEX IF EXISTS "uq_food_order_rating_order";
        ALTER TABLE "food_order_rating"
            ADD CONSTRAINT "uq_food_order_rating_order"
            UNIQUE ("food_order_id");
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'food_order_rating_order_fkey'
    ) THEN
        ALTER TABLE "food_order_rating"
            ADD CONSTRAINT "food_order_rating_order_fkey"
            FOREIGN KEY ("food_order_id") REFERENCES "food_order"("food_order_id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'food_order_rating_user_fkey'
    ) THEN
        ALTER TABLE "food_order_rating"
            ADD CONSTRAINT "food_order_rating_user_fkey"
            FOREIGN KEY ("user_id") REFERENCES "user"("user_id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'food_order_rating_vendor_fkey'
    ) THEN
        ALTER TABLE "food_order_rating"
            ADD CONSTRAINT "food_order_rating_vendor_fkey"
            FOREIGN KEY ("vendor_id") REFERENCES "food_vendor"("vendor_id")
            ON DELETE NO ACTION ON UPDATE NO ACTION;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_food_order_rating_vendor" ON "food_order_rating"("vendor_id");
CREATE INDEX IF NOT EXISTS "idx_food_order_rating_user" ON "food_order_rating"("user_id");
