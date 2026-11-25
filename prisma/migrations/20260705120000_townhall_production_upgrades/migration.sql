-- Town Hall production upgrades: post moderation flags (pin/sensitive/banned),
-- social-marketplace product pinning, and live polls.
--
-- FULLY ADDITIVE + IDEMPOTENT: every statement is guarded so it neither alters nor
-- drops any existing column/table, and re-running is a no-op. No existing Town Hall
-- feature can be lost by applying this.

-- 1. New moderation + product-pin columns on town_hall_post ------------------------
ALTER TABLE "town_hall_post" ADD COLUMN IF NOT EXISTS "is_pinned"    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "town_hall_post" ADD COLUMN IF NOT EXISTS "is_sensitive" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "town_hall_post" ADD COLUMN IF NOT EXISTS "is_banned"    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "town_hall_post" ADD COLUMN IF NOT EXISTS "product_id"   INTEGER;

-- Performance indexes (the base table only had scheduled_at) -----------------------
CREATE INDEX IF NOT EXISTS "town_hall_post_user_id_idx"       ON "town_hall_post"("user_id");
CREATE INDEX IF NOT EXISTS "town_hall_post_parent_id_idx"     ON "town_hall_post"("parent_id");
CREATE INDEX IF NOT EXISTS "town_hall_post_quote_post_id_idx" ON "town_hall_post"("quote_post_id");
CREATE INDEX IF NOT EXISTS "town_hall_post_product_id_idx"    ON "town_hall_post"("product_id");

-- FK: product_id -> product_listing(listing_id), null out on product delete --------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'town_hall_post_product_id_fkey') THEN
    ALTER TABLE "town_hall_post"
      ADD CONSTRAINT "town_hall_post_product_id_fkey"
      FOREIGN KEY ("product_id") REFERENCES "product_listing"("listing_id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- 2. Live poll tables --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "town_hall_poll_option" (
  "option_id"   SERIAL       NOT NULL,
  "post_id"     INTEGER      NOT NULL,
  "option_text" VARCHAR(100) NOT NULL,
  CONSTRAINT "town_hall_poll_option_pkey" PRIMARY KEY ("option_id")
);
CREATE INDEX IF NOT EXISTS "town_hall_poll_option_post_id_idx" ON "town_hall_poll_option"("post_id");

CREATE TABLE IF NOT EXISTS "town_hall_poll_vote" (
  "vote_id"   SERIAL  NOT NULL,
  "option_id" INTEGER NOT NULL,
  "user_id"   INTEGER NOT NULL,
  CONSTRAINT "town_hall_poll_vote_pkey" PRIMARY KEY ("vote_id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "town_hall_poll_vote_option_id_user_id_key" ON "town_hall_poll_vote"("option_id", "user_id");
CREATE INDEX IF NOT EXISTS "town_hall_poll_vote_option_id_idx" ON "town_hall_poll_vote"("option_id");
CREATE INDEX IF NOT EXISTS "town_hall_poll_vote_user_id_idx"   ON "town_hall_poll_vote"("user_id");

-- Poll FKs -------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'town_hall_poll_option_post_id_fkey') THEN
    ALTER TABLE "town_hall_poll_option"
      ADD CONSTRAINT "town_hall_poll_option_post_id_fkey"
      FOREIGN KEY ("post_id") REFERENCES "town_hall_post"("post_id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'town_hall_poll_vote_option_id_fkey') THEN
    ALTER TABLE "town_hall_poll_vote"
      ADD CONSTRAINT "town_hall_poll_vote_option_id_fkey"
      FOREIGN KEY ("option_id") REFERENCES "town_hall_poll_option"("option_id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'town_hall_poll_vote_user_id_fkey') THEN
    ALTER TABLE "town_hall_poll_vote"
      ADD CONSTRAINT "town_hall_poll_vote_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "user"("user_id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
