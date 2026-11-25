-- Phase 3: LinkedIn-style structured résumé on candidate profile.
ALTER TABLE "candidate" ADD COLUMN IF NOT EXISTS "resume_json" JSONB;
