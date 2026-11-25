-- Wishlist & social gifting feature
-- Additive only: CREATE TABLE IF NOT EXISTS

CREATE TABLE IF NOT EXISTS "wishlist_item" (
  "wishlist_item_id" SERIAL PRIMARY KEY,
  "owner_id"         INTEGER NOT NULL,
  "item_type"        VARCHAR(20) NOT NULL,
  "item_ref_id"      INTEGER,
  "title"            VARCHAR(500) NOT NULL,
  "description"      TEXT,
  "image_url"        TEXT,
  "price"            DECIMAL(12,2) NOT NULL,
  "currency"         VARCHAR(3) NOT NULL DEFAULT 'CAD',
  "status"           VARCHAR(20) NOT NULL DEFAULT 'active',
  "created_at"       TIMESTAMP(6) NOT NULL DEFAULT now(),
  "updated_at"       TIMESTAMP(6),
  CONSTRAINT "wishlist_item_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "user"("user_id")
    ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX IF NOT EXISTS "idx_wishlist_item_owner"  ON "wishlist_item"("owner_id");
CREATE INDEX IF NOT EXISTS "idx_wishlist_item_status" ON "wishlist_item"("status");

CREATE TABLE IF NOT EXISTS "wishlist_contribution" (
  "contribution_id"   SERIAL PRIMARY KEY,
  "wishlist_item_id"  INTEGER NOT NULL,
  "contributor_id"    INTEGER NOT NULL,
  "amount"            DECIMAL(12,2) NOT NULL,
  "payment_method"    VARCHAR(20) NOT NULL DEFAULT 'wallet',
  "status"            VARCHAR(20) NOT NULL DEFAULT 'completed',
  "note"              VARCHAR(500),
  "created_at"        TIMESTAMP(6) NOT NULL DEFAULT now(),
  CONSTRAINT "wishlist_contribution_item_fkey"
    FOREIGN KEY ("wishlist_item_id") REFERENCES "wishlist_item"("wishlist_item_id")
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "wishlist_contribution_contributor_fkey"
    FOREIGN KEY ("contributor_id") REFERENCES "user"("user_id")
    ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE INDEX IF NOT EXISTS "idx_wishlist_contribution_item" ON "wishlist_contribution"("wishlist_item_id");
CREATE INDEX IF NOT EXISTS "idx_wishlist_contribution_user" ON "wishlist_contribution"("contributor_id");
