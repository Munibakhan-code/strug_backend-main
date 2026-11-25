-- Server-side food modifier catalog — additive, idempotent.
-- Replaces the client-only (localStorage) modifier data so the payment route can
-- price food modifiers EXACTLY by server-owned option_id (see resolveLinePrices).
-- Safe to re-run: CREATE TABLE/INDEX IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS "food_item_modifier_group" (
    "group_id" SERIAL NOT NULL,
    "food_item_id" INTEGER,
    "name" VARCHAR(255),
    "min_select" INTEGER DEFAULT 0,
    "max_select" INTEGER,
    "sort_order" INTEGER DEFAULT 0,
    CONSTRAINT "food_item_modifier_group_pkey" PRIMARY KEY ("group_id"),
    CONSTRAINT "food_item_modifier_group_food_item_id_fkey" FOREIGN KEY ("food_item_id") REFERENCES "food_item"("food_item_id") ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE INDEX IF NOT EXISTS "idx_food_item_modifier_group_food_item" ON "food_item_modifier_group"("food_item_id");

CREATE TABLE IF NOT EXISTS "food_item_modifier_option" (
    "option_id" SERIAL NOT NULL,
    "group_id" INTEGER,
    "name" VARCHAR(255),
    "price" DOUBLE PRECISION DEFAULT 0,
    "is_available" BOOLEAN DEFAULT true,
    "sort_order" INTEGER DEFAULT 0,
    CONSTRAINT "food_item_modifier_option_pkey" PRIMARY KEY ("option_id"),
    CONSTRAINT "food_item_modifier_option_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "food_item_modifier_group"("group_id") ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE INDEX IF NOT EXISTS "idx_food_item_modifier_option_group" ON "food_item_modifier_option"("group_id");
