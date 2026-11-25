-- Per-vertical display identity (bug #3: profile bleed across verticals).
-- Additive only. The shared social_profile stays the user's "main" identity;
-- this table holds an independent identity per vertical that has an edit-profile flow.

CREATE TABLE IF NOT EXISTS "vertical_profile" (
    "vertical_profile_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "vertical" VARCHAR(50) NOT NULL,
    "handle" VARCHAR(50),
    "display_name" VARCHAR(100),
    "business_name" VARCHAR(150),
    "bio" TEXT,
    "profile_pic_url" TEXT,
    "banner_url" TEXT,
    "website" VARCHAR(300),
    "location" VARCHAR(200),
    "is_customized" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vertical_profile_pkey" PRIMARY KEY ("vertical_profile_id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "vertical_profile_handle_key" ON "vertical_profile"("handle");
CREATE UNIQUE INDEX IF NOT EXISTS "vertical_profile_user_id_vertical_key" ON "vertical_profile"("user_id", "vertical");
CREATE INDEX IF NOT EXISTS "vertical_profile_user_id_idx" ON "vertical_profile"("user_id");
CREATE INDEX IF NOT EXISTS "vertical_profile_vertical_idx" ON "vertical_profile"("vertical");
CREATE INDEX IF NOT EXISTS "vertical_profile_handle_idx" ON "vertical_profile"("handle");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'vertical_profile_user_id_fkey'
    ) THEN
        ALTER TABLE "vertical_profile"
            ADD CONSTRAINT "vertical_profile_user_id_fkey"
            FOREIGN KEY ("user_id") REFERENCES "user"("user_id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
