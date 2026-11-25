-- First-class wedding try-on / boutique appointment rows (notifications remain for inbox UX).
CREATE TABLE IF NOT EXISTS "wedding_try_on" (
    "try_on_id" SERIAL NOT NULL,
    "listing_id" INTEGER NOT NULL,
    "seller_id" INTEGER NOT NULL,
    "buyer_id" INTEGER NOT NULL,
    "product_name" VARCHAR(255),
    "preferred_date" DATE NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "seller_notification_id" INTEGER,
    "buyer_notification_id" INTEGER,
    "resolved_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),

    CONSTRAINT "wedding_try_on_pkey" PRIMARY KEY ("try_on_id")
);

CREATE INDEX IF NOT EXISTS "idx_wedding_try_on_seller" ON "wedding_try_on"("seller_id", "status", "created_at");
CREATE INDEX IF NOT EXISTS "idx_wedding_try_on_buyer" ON "wedding_try_on"("buyer_id", "created_at");
CREATE INDEX IF NOT EXISTS "idx_wedding_try_on_listing_date" ON "wedding_try_on"("listing_id", "preferred_date");
