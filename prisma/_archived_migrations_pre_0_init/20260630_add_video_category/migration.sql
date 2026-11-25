-- Add nullable category to video (defaults to 'General'). Additive, idempotent.
ALTER TABLE "video" ADD COLUMN IF NOT EXISTS "category" TEXT DEFAULT 'General';
