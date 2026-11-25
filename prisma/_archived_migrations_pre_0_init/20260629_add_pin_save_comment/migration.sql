-- Pinboard: save-to-board + comments. Additive + idempotent (safe to re-run /
-- safe on a drifted prod DB). FKs added via DO-blocks so a re-apply is a no-op.

-- Save a pin to your board (one row per user+pin).
CREATE TABLE IF NOT EXISTS "pin_save" (
    "pin_save_id" SERIAL NOT NULL,
    "pin_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "saved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pin_save_pkey" PRIMARY KEY ("pin_save_id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "pin_save_pin_id_user_id_key" ON "pin_save"("pin_id", "user_id");
CREATE INDEX IF NOT EXISTS "pin_save_user_id_idx" ON "pin_save"("user_id");
CREATE INDEX IF NOT EXISTS "pin_save_pin_id_idx" ON "pin_save"("pin_id");

DO $$ BEGIN
    ALTER TABLE "pin_save" ADD CONSTRAINT "pin_save_pin_id_fkey" FOREIGN KEY ("pin_id") REFERENCES "pin"("pin_id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "pin_save" ADD CONSTRAINT "pin_save_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A comment on a pin.
CREATE TABLE IF NOT EXISTS "pin_comment" (
    "pin_comment_id" SERIAL NOT NULL,
    "pin_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "body" VARCHAR(1000) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pin_comment_pkey" PRIMARY KEY ("pin_comment_id")
);

CREATE INDEX IF NOT EXISTS "pin_comment_pin_id_idx" ON "pin_comment"("pin_id");
CREATE INDEX IF NOT EXISTS "pin_comment_user_id_idx" ON "pin_comment"("user_id");

DO $$ BEGIN
    ALTER TABLE "pin_comment" ADD CONSTRAINT "pin_comment_pin_id_fkey" FOREIGN KEY ("pin_id") REFERENCES "pin"("pin_id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "pin_comment" ADD CONSTRAINT "pin_comment_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
