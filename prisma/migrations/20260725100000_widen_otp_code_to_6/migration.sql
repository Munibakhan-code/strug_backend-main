-- Widen delivery / ride handoff OTP columns so 6-digit codes persist safely.
-- Existing 4-digit values remain valid; generators now emit 100000–999999.

ALTER TABLE "food_order"
  ALTER COLUMN "otp_code" TYPE VARCHAR(6);

ALTER TABLE "active_trip"
  ALTER COLUMN "otp_code" TYPE VARCHAR(6);
