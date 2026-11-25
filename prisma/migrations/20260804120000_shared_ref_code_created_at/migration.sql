-- Recruiter Phase 1: join date for multi-ongoing recruit list / period filters.
ALTER TABLE "shared_ref_code" ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS "shared_ref_code_ref_code_created_at_idx" ON "shared_ref_code"("ref_code", "created_at");
