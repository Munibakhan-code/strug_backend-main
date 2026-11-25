-- Allow multiple users to apply the same referral code.
-- Previously ref_code had a UNIQUE constraint, meaning each code could only be used once.
-- New compound unique on (shared_to, ref_code) prevents a single user from applying the same code twice.

-- Drop the per-column unique constraint
ALTER TABLE "shared_ref_code" DROP CONSTRAINT IF EXISTS "shared_ref_code_ref_code_key";

-- Add compound unique: one application of a given code per user
CREATE UNIQUE INDEX IF NOT EXISTS "shared_ref_code_shared_to_ref_code_key" ON "shared_ref_code"("shared_to", "ref_code");
