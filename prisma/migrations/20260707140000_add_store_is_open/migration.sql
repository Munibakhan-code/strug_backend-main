-- Phase 3: temporary closed state for shop storefronts (Food-style is_open).
-- is_active=false hides the store from public browse; is_open=false keeps it visible but not orderable.
ALTER TABLE "store_profile" ADD COLUMN "is_open" BOOLEAN NOT NULL DEFAULT true;
