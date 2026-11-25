-- Jobs Phase 9: speed open+newest list and posted_date sorts
CREATE INDEX IF NOT EXISTS "jobs_posted_date_idx" ON "jobs"("posted_date");
CREATE INDEX IF NOT EXISTS "jobs_status_posted_date_idx" ON "jobs"("status", "posted_date");
