-- Separate admin suspension from seller operational state.
-- When set, owners must not self-reactivate via PUT /food/vendors/:id.
ALTER TABLE "food_vendor"
  ADD COLUMN IF NOT EXISTS "admin_deactivated_at" TIMESTAMP(6);
