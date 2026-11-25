-- Add clipped_by_user_id so viewer-created clips can show "Clipped by"

ALTER TABLE "live_vod" ADD COLUMN IF NOT EXISTS "clipped_by_user_id" INTEGER;

CREATE INDEX IF NOT EXISTS "live_vod_clipped_by_user_id_idx" ON "live_vod"("clipped_by_user_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'live_vod_clipped_by_user_id_fkey'
  ) THEN
    ALTER TABLE "live_vod"
      ADD CONSTRAINT "live_vod_clipped_by_user_id_fkey"
      FOREIGN KEY ("clipped_by_user_id") REFERENCES "user"("user_id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
