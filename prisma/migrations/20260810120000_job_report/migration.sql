-- Jobs Phase 8: seeker reports + moderation audit fields
CREATE TABLE IF NOT EXISTS "job_report" (
    "report_id" SERIAL NOT NULL,
    "job_id" INTEGER NOT NULL,
    "reporter_id" INTEGER NOT NULL,
    "reason" VARCHAR(80) NOT NULL,
    "details" TEXT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "resolved_by" INTEGER,
    "resolution_note" TEXT,
    "action_taken" VARCHAR(40),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),

    CONSTRAINT "job_report_pkey" PRIMARY KEY ("report_id")
);

CREATE INDEX IF NOT EXISTS "idx_job_report_status" ON "job_report"("status");
CREATE INDEX IF NOT EXISTS "idx_job_report_job" ON "job_report"("job_id");
CREATE INDEX IF NOT EXISTS "idx_job_report_reporter" ON "job_report"("reporter_id");

ALTER TABLE "job_report"
  ADD CONSTRAINT "job_report_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "jobs"("job_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "job_report"
  ADD CONSTRAINT "job_report_reporter_id_fkey"
  FOREIGN KEY ("reporter_id") REFERENCES "user"("user_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "job_report"
  ADD CONSTRAINT "job_report_resolved_by_fkey"
  FOREIGN KEY ("resolved_by") REFERENCES "user"("user_id")
  ON DELETE SET NULL ON UPDATE CASCADE;
