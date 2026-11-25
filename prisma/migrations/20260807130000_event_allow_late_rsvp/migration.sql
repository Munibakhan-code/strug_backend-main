ALTER TABLE "event_plan" ADD COLUMN IF NOT EXISTS "allow_late_rsvp" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "event_plan" ADD COLUMN IF NOT EXISTS "collaborators" JSONB;
