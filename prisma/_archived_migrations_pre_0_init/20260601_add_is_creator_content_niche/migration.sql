-- Add is_creator flag to user table
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "is_creator" BOOLEAN NOT NULL DEFAULT false;

-- Add content_niche to channel table
ALTER TABLE "channel" ADD COLUMN IF NOT EXISTS "content_niche" TEXT;
