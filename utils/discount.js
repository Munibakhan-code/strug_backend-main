// Shared discount math. A product_variation can carry an optional `discount_pct`
// (percent off, 0..95). The discounted price is ALWAYS derived from `price` here —
// never stored — so the storefront display and the server-authoritative charge
// (payment-routes.js / product-order-routes.js) can never drift apart.

// Normalize a raw discount percent into an integer 0..95. Anything invalid,
// negative, or zero means "no sale".
export function clampDiscountPct(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(95, Math.round(n));
}

// Price after applying the discount, rounded to cents. Returns the base price
// unchanged when there is no valid discount. Non-numeric price is passed through.
export function effectivePrice(price, pct) {
  if (price == null) return price;
  const base = Number(price);
  if (!Number.isFinite(base)) return price;
  const p = clampDiscountPct(pct);
  if (!p) return base;
  return Math.round(base * (1 - p / 100) * 100) / 100;
}
