ALTER TABLE "dating_swipe"
  DROP CONSTRAINT IF EXISTS "dating_swipe_action_check";

ALTER TABLE "dating_swipe"
  ADD CONSTRAINT "dating_swipe_action_check"
  CHECK ("action" IN ('like', 'pass', 'super_like', 'block'));
