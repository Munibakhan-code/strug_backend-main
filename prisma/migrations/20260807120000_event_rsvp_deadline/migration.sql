-- Event Concierge: RSVP deadline for host reminders + guest-facing invite copy
ALTER TABLE "event_plan" ADD COLUMN IF NOT EXISTS "rsvp_deadline" TIMESTAMP(6);
