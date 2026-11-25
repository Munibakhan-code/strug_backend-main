-- Add missing video columns: is_sensitive (default false) and digital_hash (unique nullable)
ALTER TABLE "video" ADD COLUMN IF NOT EXISTS "is_sensitive" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "video" ADD COLUMN IF NOT EXISTS "digital_hash" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "video_digital_hash_key" ON "video"("digital_hash");
