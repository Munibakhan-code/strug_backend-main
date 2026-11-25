-- Persist driver arrival at pickup for active-trip workflow (Phase 3 Task 2)
ALTER TABLE "active_trip" ADD COLUMN IF NOT EXISTS "driver_arrived_at" TIMESTAMP(6);
