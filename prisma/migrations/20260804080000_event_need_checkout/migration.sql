-- Per-item checkout linkage on event planner needs
ALTER TABLE "event_need" ADD COLUMN IF NOT EXISTS "linked_listing_id" INTEGER;
ALTER TABLE "event_need" ADD COLUMN IF NOT EXISTS "linked_listing_title" VARCHAR(300);
ALTER TABLE "event_need" ADD COLUMN IF NOT EXISTS "booking_id" INTEGER;
