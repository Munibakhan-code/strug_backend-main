-- AlterTable
ALTER TABLE "property" ADD COLUMN IF NOT EXISTS "property_name" VARCHAR(255),
                       ADD COLUMN IF NOT EXISTS "description" TEXT,
                       ADD COLUMN IF NOT EXISTS "status" VARCHAR(50);
