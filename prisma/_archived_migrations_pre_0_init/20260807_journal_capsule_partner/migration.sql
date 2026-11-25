ALTER TABLE "journal_time_capsule" ADD COLUMN IF NOT EXISTS "partner_contents" JSONB;
ALTER TABLE "journal_time_capsule" ADD COLUMN IF NOT EXISTS "partner_id" INTEGER;
CREATE INDEX IF NOT EXISTS "idx_journal_time_capsule_partner" ON "journal_time_capsule"("partner_id");
