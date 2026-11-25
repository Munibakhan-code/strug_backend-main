-- Storefront visibility toggle (#348) — additive.
-- Lets a seller hide/deactivate their whole storefront from the public shop browse
-- WITHOUT deleting any product listings. The public shop excludes stores whose
-- is_active = false; the seller still sees the store in their own dashboard to re-enable.
ALTER TABLE "store_profile" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;
