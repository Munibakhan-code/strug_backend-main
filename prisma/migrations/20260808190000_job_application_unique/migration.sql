-- Phase 2: one application per seeker per job (dedupe at DB).
-- Safe if duplicates already cleaned; IF NOT EXISTS avoids re-run failures.
CREATE UNIQUE INDEX IF NOT EXISTS "job_application_job_id_candidate_id_key"
  ON "job_application" ("job_id", "candidate_id");
