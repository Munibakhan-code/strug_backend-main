-- Jobs vertical: additive columns + btree indexes only (no pg_trgm — prod does not
-- allowlist it and an unguarded trigram index jams later staging migrations).

-- AlterTable: employer profile (agents)
ALTER TABLE "agents"
  ADD COLUMN "company_logo_url"    TEXT,
  ADD COLUMN "company_description" TEXT,
  ADD COLUMN "company_size"        TEXT,
  ADD COLUMN "industry"            TEXT;

-- AlterTable: job-seeker profile (candidate)
ALTER TABLE "candidate"
  ADD COLUMN "headline"         TEXT,
  ADD COLUMN "bio"              TEXT,
  ADD COLUMN "skills"           TEXT,
  ADD COLUMN "resume_url"       TEXT,
  ADD COLUMN "location"         TEXT,
  ADD COLUMN "desired_salary"   DOUBLE PRECISION,
  ADD COLUMN "years_experience" INTEGER;

-- AlterTable: job posting (jobs)
ALTER TABLE "jobs"
  ADD COLUMN "location"         TEXT,
  ADD COLUMN "is_remote"        BOOLEAN,
  ADD COLUMN "employment_type"  TEXT,
  ADD COLUMN "salary_min"       DOUBLE PRECISION,
  ADD COLUMN "salary_max"       DOUBLE PRECISION,
  ADD COLUMN "salary_period"    TEXT,
  ADD COLUMN "experience_level" TEXT,
  ADD COLUMN "status"           TEXT DEFAULT 'open';

-- AlterTable: application (job_application)
ALTER TABLE "job_application"
  ADD COLUMN "cover_letter" TEXT,
  ADD COLUMN "status"       TEXT DEFAULT 'applied',
  ADD COLUMN "updated_at"   TIMESTAMP(6);

-- Indexes (btree)
CREATE INDEX "jobs_status_idx" ON "jobs"("status");
CREATE INDEX "jobs_job_category_id_idx" ON "jobs"("job_category_id");
CREATE INDEX "jobs_agent_id_idx" ON "jobs"("agent_id");
CREATE INDEX "job_application_candidate_id_idx" ON "job_application"("candidate_id");
CREATE INDEX "job_application_job_id_idx" ON "job_application"("job_id");
