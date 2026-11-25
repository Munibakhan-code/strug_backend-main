-- Floor plan images: keep the raw upload alongside the background-removed display
-- image, and record whether processing succeeded so the UI can fall back safely.
ALTER TABLE "property_floor_plan" ADD COLUMN IF NOT EXISTS "original_image_url" VARCHAR(1000);
ALTER TABLE "property_floor_plan" ADD COLUMN IF NOT EXISTS "image_processed" BOOLEAN NOT NULL DEFAULT false;
