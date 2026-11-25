-- Link booking.guest_id / booking.host_id to user so hosts can include guest
-- identity on GET /booking/bookings (reviewer #923 / reservation host UX).
--
-- NOT VALID: existing orphan rows (if any) are not scanned; new writes are enforced.
-- Operators can later run VALIDATE CONSTRAINT after cleaning orphans.

ALTER TABLE "booking" DROP CONSTRAINT IF EXISTS "booking_guest_fkey";
ALTER TABLE "booking" DROP CONSTRAINT IF EXISTS "booking_host_fkey";

ALTER TABLE "booking"
  ADD CONSTRAINT "booking_guest_fkey"
  FOREIGN KEY ("guest_id") REFERENCES "user"("user_id")
  ON DELETE NO ACTION ON UPDATE NO ACTION
  NOT VALID;

ALTER TABLE "booking"
  ADD CONSTRAINT "booking_host_fkey"
  FOREIGN KEY ("host_id") REFERENCES "user"("user_id")
  ON DELETE NO ACTION ON UPDATE NO ACTION
  NOT VALID;
