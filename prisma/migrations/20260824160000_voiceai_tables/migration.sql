-- The Voice AI models shipped in schema.prisma without any SQL behind them.
--
-- voiceai_generation and voiceai_voice_preset are the only two models in the whole schema
-- with no CREATE TABLE in prisma/migrations. CI stays green because it runs `db push`, which
-- creates them from the datamodel; `migrate deploy` does not, so on any real environment the
-- tables are simply absent. Staging shows it now: GET /voiceai/voices and GET /voiceai/history
-- both 500 with DATABASE_ERROR. Production hasn't served these routes yet (404), so promoting
-- the branch without this file would add endpoints to prod that fail on their first query.
--
-- Written from the models as they stand, so `migrate deploy` produces what `db push` already
-- produces. Guarded throughout: environments that got the tables from a db push keep them.

CREATE TABLE IF NOT EXISTS "voiceai_generation" (
    "voiceai_generation_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "exaggeration" DOUBLE PRECISION,
    "modal_voice_id" TEXT,
    "audio_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "provider" TEXT NOT NULL DEFAULT 'chatterbox',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voiceai_generation_pkey" PRIMARY KEY ("voiceai_generation_id")
);

CREATE TABLE IF NOT EXISTS "voiceai_voice_preset" (
    "voiceai_voice_preset_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "modal_voice_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "avatar" TEXT,
    "avatar_url" TEXT,
    "sample_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voiceai_voice_preset_pkey" PRIMARY KEY ("voiceai_voice_preset_id")
);

CREATE INDEX IF NOT EXISTS "voiceai_generation_user_id_idx" ON "voiceai_generation"("user_id");
CREATE INDEX IF NOT EXISTS "voiceai_generation_status_idx" ON "voiceai_generation"("status");
CREATE INDEX IF NOT EXISTS "voiceai_generation_created_at_idx" ON "voiceai_generation"("created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "voiceai_voice_preset_modal_voice_id_key" ON "voiceai_voice_preset"("modal_voice_id");
CREATE INDEX IF NOT EXISTS "voiceai_voice_preset_user_id_idx" ON "voiceai_voice_preset"("user_id");

-- ADD CONSTRAINT has no IF NOT EXISTS in Postgres, so each FK is guarded on pg_constraint.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'voiceai_generation_user_id_fkey') THEN
    ALTER TABLE "voiceai_generation" ADD CONSTRAINT "voiceai_generation_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'voiceai_voice_preset_user_id_fkey') THEN
    ALTER TABLE "voiceai_voice_preset" ADD CONSTRAINT "voiceai_voice_preset_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;
