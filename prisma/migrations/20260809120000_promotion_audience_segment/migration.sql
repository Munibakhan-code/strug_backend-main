-- Opportunities segment targeting for seller food promotions.
ALTER TABLE "promotion" ADD COLUMN IF NOT EXISTS "audience_segment" VARCHAR(40);

CREATE INDEX IF NOT EXISTS "idx_promotion_audience_status" ON "promotion" ("audience_segment", "status");
