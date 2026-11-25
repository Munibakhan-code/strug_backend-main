ALTER TABLE "user"
  ADD COLUMN IF NOT EXISTS "document_verification_status" VARCHAR(24) NOT NULL DEFAULT 'unsubmitted',
  ADD COLUMN IF NOT EXISTS "document_verification_type" VARCHAR(80),
  ADD COLUMN IF NOT EXISTS "document_verification_submitted_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "document_verified_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "document_verification_rejected_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "document_verification_reviewed_by" INTEGER,
  ADD COLUMN IF NOT EXISTS "document_verification_rejection_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "document_verification_document_url" TEXT,
  ADD COLUMN IF NOT EXISTS "document_verification_document_name" VARCHAR(255);

CREATE INDEX IF NOT EXISTS "idx_user_document_verification_status"
  ON "user" ("document_verification_status");
