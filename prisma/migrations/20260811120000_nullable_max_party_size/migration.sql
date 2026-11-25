-- Issue 4: seating capacity must not invent a configured value.
-- Drop NOT NULL + DEFAULT 12 so new vendors stay unset until the seller saves a number.
-- Existing rows that still hold the old default (12) are cleared so the edit form
-- shows empty instead of a fake "12". Sellers who truly want a max of 12 re-enter it once.
ALTER TABLE "food_vendor"
  ALTER COLUMN "max_party_size" DROP DEFAULT,
  ALTER COLUMN "max_party_size" DROP NOT NULL;

UPDATE "food_vendor"
SET "max_party_size" = NULL
WHERE "max_party_size" = 12;
