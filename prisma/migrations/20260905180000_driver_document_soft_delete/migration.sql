-- #1296 soft-delete / retain driver KYC docs when profile is removed
ALTER TABLE "driver_document" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3);

-- Drop Cascade FK so profile delete cannot wipe compliance artifacts.
ALTER TABLE "driver_document" DROP CONSTRAINT IF EXISTS "driver_document_driver_profile_id_fkey";

-- Allow archived rows to detach from a deleted profile.
ALTER TABLE "driver_document" ALTER COLUMN "driver_profile_id" DROP NOT NULL;

-- Replace hard unique with partial unique for active rows only.
ALTER TABLE "driver_document" DROP CONSTRAINT IF EXISTS "driver_document_driver_profile_id_doc_type_key";
DROP INDEX IF EXISTS "driver_document_driver_profile_id_doc_type_key";

CREATE UNIQUE INDEX IF NOT EXISTS "driver_document_active_profile_type_key"
  ON "driver_document" ("driver_profile_id", "doc_type")
  WHERE "deleted_at" IS NULL AND "driver_profile_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "driver_document_deleted_at_idx" ON "driver_document" ("deleted_at");

ALTER TABLE "driver_document"
  ADD CONSTRAINT "driver_document_driver_profile_id_fkey"
  FOREIGN KEY ("driver_profile_id") REFERENCES "driver_profile"("driver_profile_id")
  ON DELETE SET NULL ON UPDATE NO ACTION;

-- #1295: AEAD ciphertext needs more room than plaintext account numbers
ALTER TABLE "WithdrawalRequest" ALTER COLUMN "account_number" TYPE VARCHAR(512);
ALTER TABLE "ArtistWithdrawalRequest" ALTER COLUMN "account_number" TYPE VARCHAR(512);
ALTER TABLE "CelebrityWithdrawalRequest" ALTER COLUMN "account_number" TYPE VARCHAR(512);
