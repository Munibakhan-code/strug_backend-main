-- Persist why a ride_request was cancelled (passenger vs no-driver system cancel).
ALTER TABLE "ride_request" ADD COLUMN IF NOT EXISTS "cancellation_reason" TEXT;
