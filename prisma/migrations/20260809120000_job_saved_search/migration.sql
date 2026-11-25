-- Jobs Phase 5: seeker saved searches + alert watermarks
CREATE TABLE IF NOT EXISTS "job_saved_search" (
    "saved_search_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "name" VARCHAR(120),
    "filters" JSONB NOT NULL,
    "frequency" VARCHAR(20) NOT NULL DEFAULT 'immediate',
    "alert_enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_notified_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),

    CONSTRAINT "job_saved_search_pkey" PRIMARY KEY ("saved_search_id")
);

CREATE INDEX IF NOT EXISTS "idx_job_saved_search_user" ON "job_saved_search"("user_id");
CREATE INDEX IF NOT EXISTS "idx_job_saved_search_alert" ON "job_saved_search"("alert_enabled");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'job_saved_search_user_id_fkey'
  ) THEN
    ALTER TABLE "job_saved_search"
      ADD CONSTRAINT "job_saved_search_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "user"("user_id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
