-- Universal favourites (polymorphic saves across verticals)
CREATE TABLE IF NOT EXISTS "saved_item" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "entity_type" VARCHAR(40) NOT NULL,
    "entity_id" VARCHAR(128) NOT NULL,
    "meta" JSONB,
    "saved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_item_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "saved_item_user_id_entity_type_entity_id_key" ON "saved_item"("user_id", "entity_type", "entity_id");
CREATE INDEX IF NOT EXISTS "saved_item_user_id_idx" ON "saved_item"("user_id");

DO $$ BEGIN
    ALTER TABLE "saved_item" ADD CONSTRAINT "saved_item_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Pinboard (user-created visual pins)
CREATE TABLE IF NOT EXISTS "pin" (
    "pin_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "category" VARCHAR(60),
    "image_url" TEXT,
    "target_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pin_pkey" PRIMARY KEY ("pin_id")
);

CREATE INDEX IF NOT EXISTS "pin_user_id_idx" ON "pin"("user_id");
CREATE INDEX IF NOT EXISTS "pin_category_idx" ON "pin"("category");

DO $$ BEGIN
    ALTER TABLE "pin" ADD CONSTRAINT "pin_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
