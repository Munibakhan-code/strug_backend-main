ALTER TABLE "dating_date_plan"
  ADD COLUMN IF NOT EXISTS "deposit_amount" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "cancellation_window_hours" INTEGER,
  ADD COLUMN IF NOT EXISTS "attendance_score_required" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "add_ons" JSONB;
