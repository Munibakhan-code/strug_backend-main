-- Jobs Phase 3 ATS: employer notes, interview fields, status timeline events
ALTER TABLE "job_application" ADD COLUMN IF NOT EXISTS "employer_notes" TEXT;
ALTER TABLE "job_application" ADD COLUMN IF NOT EXISTS "interview_at" TIMESTAMP(6);
ALTER TABLE "job_application" ADD COLUMN IF NOT EXISTS "interview_notes" TEXT;

CREATE TABLE IF NOT EXISTS "job_application_event" (
    "event_id" SERIAL NOT NULL,
    "job_application_id" INTEGER NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT,
    "event_type" VARCHAR(32) NOT NULL DEFAULT 'status',
    "note" TEXT,
    "actor_user_id" INTEGER,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_application_event_pkey" PRIMARY KEY ("event_id")
);

CREATE INDEX IF NOT EXISTS "job_application_event_job_application_id_idx" ON "job_application_event"("job_application_id");
CREATE INDEX IF NOT EXISTS "job_application_event_created_at_idx" ON "job_application_event"("created_at");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'job_application_event_job_application_id_fkey'
  ) THEN
    ALTER TABLE "job_application_event"
      ADD CONSTRAINT "job_application_event_job_application_id_fkey"
      FOREIGN KEY ("job_application_id") REFERENCES "job_application"("job_application_id")
      ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;
