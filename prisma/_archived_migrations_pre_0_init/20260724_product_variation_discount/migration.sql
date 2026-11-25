-- Optional per-variation sale: percent off the price (0..95). null/0 = not on sale.
-- Additive only (prod has migration drift — see CLAUDE.md). Discounted price is
-- always derived from `price` server-side, never stored, so display == charge.
ALTER TABLE "product_variation" ADD COLUMN IF NOT EXISTS "discount_pct" DOUBLE PRECISION;
