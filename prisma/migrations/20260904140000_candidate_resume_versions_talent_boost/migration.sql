-- Jobs Phase 4b: multi-resume versions + paid talent-pool boost window.
ALTER TABLE "candidate" ADD COLUMN IF NOT EXISTS "talent_boosted_until" TIMESTAMP(6);

CREATE TABLE IF NOT EXISTS "candidate_resume" (
    "resume_version_id" SERIAL NOT NULL,
    "candidate_id" INTEGER NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "resume_json" JSONB,
    "resume_url" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_resume_pkey" PRIMARY KEY ("resume_version_id")
);

CREATE INDEX IF NOT EXISTS "candidate_resume_candidate_id_idx"
  ON "candidate_resume"("candidate_id");

CREATE INDEX IF NOT EXISTS "candidate_talent_boosted_until_idx"
  ON "candidate"("talent_boosted_until");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'candidate_resume_candidate_id_fkey'
  ) THEN
    ALTER TABLE "candidate_resume"
      ADD CONSTRAINT "candidate_resume_candidate_id_fkey"
      FOREIGN KEY ("candidate_id") REFERENCES "candidate"("candidate_id")
      ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;
