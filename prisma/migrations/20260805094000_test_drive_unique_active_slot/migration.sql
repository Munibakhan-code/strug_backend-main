-- Enforce at most ONE active test-drive booking per (vehicle, date, time) slot.
-- The route pre-check (findFirst) is advisory and races under concurrency (TOCTOU);
-- this partial unique index lets the DB reject the loser, which the handler turns
-- into a clean 409. Only ACTIVE statuses count — cancelled/completed slots are reusable.
CREATE UNIQUE INDEX IF NOT EXISTS "test_drive_active_slot_key"
  ON "test_drive_request" ("vehicle_id", "preferred_date", "preferred_time")
  WHERE "status" IN ('PENDING', 'CONFIRMED');
