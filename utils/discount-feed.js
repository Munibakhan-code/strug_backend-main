import { clampDiscountPct, effectivePrice } from './discount.js';

/** Map product_type_name → Discounts browse category chip match values. */
const TYPE_TO_CATEGORY = {
  food: 'Food',
  groceries: 'Food',
  catering: 'Food',
  mealkit: 'Food',
  restaurant: 'Food',
  restaurants: 'Food',
  shop: 'Shopping',
  secondhand: 'Shopping',
  decor: 'Shopping',
  wedding: 'Shopping',
  clothing: 'Shopping',
  beauty: 'Shopping',
  books: 'Shopping',
  digitalproducts: 'Shopping',
  digproducts: 'Shopping',
  travel: 'Travel',
  hotel: 'Travel',
  tempstay: 'Travel',
  experiences: 'Travel',
  services: 'Services',
  proservices: 'Services',
  digservices: 'Services',
  ondemand: 'Services',
  floral: 'Services',
  entertainment: 'Entertainment',
  events: 'Entertainment',
  live: 'Entertainment',
  videos: 'Entertainment',
  medical: 'Health',
  health: 'Health',
  insurance: 'Health',
};

/** Map product_type_name → listing deep-link vertical slug. */
const TYPE_TO_VERTICAL = {
  food: 'food',
  groceries: 'food',
  catering: 'catering',
  shop: 'shop',
  secondhand: 'shop',
  decor: 'decor',
  wedding: 'wedding',
  clothing: 'shop',
  beauty: 'shop',
  books: 'books',
  digitalproducts: 'digital',
  digproducts: 'digital',
  hotel: 'hotel',
  tempstay: 'host',
  services: 'services',
  proservices: 'services',
  medical: 'medical',
  events: 'events',
};

function normType(name) {
  return String(name || '').replace(/\s+/g, '').toLowerCase();
}

export function browseCategoryForProductType(productTypeName) {
  return TYPE_TO_CATEGORY[normType(productTypeName)] || 'Shopping';
}

export function sourceVerticalForProductType(productTypeName) {
  return TYPE_TO_VERTICAL[normType(productTypeName)] || 'shop';
}

export function isMarkdownWindowActive(variation, now = new Date()) {
  const pct = clampDiscountPct(variation?.discount_pct);
  if (!pct) return false;
  const starts = variation?.discount_starts_at ? new Date(variation.discount_starts_at) : null;
  const ends = variation?.discount_ends_at ? new Date(variation.discount_ends_at) : null;
  if (starts && starts > now) return false;
  if (ends && ends < now) return false;
  return true;
}

export function mapListingToDeal(listing, now = new Date()) {
  const onSale = (listing.product_variation || []).find((x) => isMarkdownWindowActive(x, now));
  if (!onSale) return null;
  const typeName = listing.product_type?.product_type_name || 'Shop';
  const origPrice = Number(onSale.price) || 0;
  const pct = clampDiscountPct(onSale.discount_pct);
  const sourceVertical = sourceVerticalForProductType(typeName);
  return {
    type: 'product',
    deal_kind: 'sale',
    listing_id: listing.listing_id,
    variation_id: onSale.variation_id ?? null,
    seller_id: listing.seller_id ?? null,
    product_type_id: listing.product_type_id ?? listing.product_type?.product_type_id ?? null,
    name: listing.name,
    category: browseCategoryForProductType(typeName),
    product_type_name: typeName,
    source_vertical: sourceVertical,
    deep_link: `/listing/${sourceVertical}/${listing.listing_id}`,
    image_url: listing.image_url || onSale.image_url || null,
    orig_price: origPrice,
    sale_price: effectivePrice(origPrice, pct),
    discount_pct: pct,
    stock: listing.availability ?? null,
    expires_at: onSale.discount_ends_at || null,
    starts_at: onSale.discount_starts_at || null,
  };
}

export function mapPromotionToDeal(promo) {
  const isPercent = String(promo.discount_type).toLowerCase() === 'percent';
  return {
    type: 'promotion',
    deal_kind: promo.kind || 'coupon',
    promotion_id: promo.promotion_id,
    listing_id: null,
    variation_id: null,
    seller_id: promo.owner_user_id ?? null,
    product_type_id: null,
    name: promo.title || promo.code,
    category: promo.category || 'Shopping',
    product_type_name: null,
    source_vertical: promo.vertical || 'discounts',
    deep_link: `/discounts/promo/${promo.promotion_id}`,
    image_url: null,
    orig_price: null,
    sale_price: null,
    discount_pct: isPercent ? Number(promo.discount_value) : null,
    discount_type: promo.discount_type,
    discount_value: Number(promo.discount_value),
    // Never emit the raw redeemable code on this public mapper. Browse only needs
    // promotion_id + badge; /discounts/validate (rate-limited) hands the code out at apply.
    code: null,
    stock: promo.quantity_limit != null
      ? Math.max(0, Number(promo.quantity_limit) - Number(promo.claimed_count || 0))
      : null,
    expires_at: promo.ends_at || null,
    starts_at: promo.starts_at || null,
    description: promo.description || null,
  };
}

export function filterDeals(deals, query = {}) {
  const q = String(query.q || '').trim().toLowerCase();
  const category = String(query.category || '').trim();
  const vertical = String(query.vertical || '').trim().toLowerCase();
  const minPct = query.min_pct != null ? Number(query.min_pct) : null;
  const sort = String(query.sort || 'newest').toLowerCase();
  const kind = String(query.kind || '').trim().toLowerCase();

  let out = Array.isArray(deals) ? [...deals] : [];
  if (kind === 'sale' || kind === 'coupon' || kind === 'deal') {
    out = out.filter((d) => String(d.deal_kind || '').toLowerCase() === kind
      || (kind === 'coupon' && d.type === 'promotion' && d.deal_kind === 'coupon')
      || (kind === 'deal' && d.type === 'promotion' && d.deal_kind === 'deal'));
  }
  if (category) {
    out = out.filter((d) => String(d.category || '').toLowerCase() === category.toLowerCase());
  }
  if (vertical) {
    out = out.filter((d) => String(d.source_vertical || '').toLowerCase() === vertical);
  }
  if (minPct != null && Number.isFinite(minPct)) {
    out = out.filter((d) => Number(d.discount_pct || 0) >= minPct);
  }
  if (q) {
    out = out.filter((d) => {
      const hay = `${d.name || ''} ${d.category || ''} ${d.product_type_name || ''} ${d.code || ''} ${d.description || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }
  if (sort === 'ending_soon') {
    out.sort((a, b) => {
      const ae = a.expires_at ? new Date(a.expires_at).getTime() : Number.POSITIVE_INFINITY;
      const be = b.expires_at ? new Date(b.expires_at).getTime() : Number.POSITIVE_INFINITY;
      return ae - be;
    });
  } else if (sort === 'biggest') {
    out.sort((a, b) => Number(b.discount_pct || 0) - Number(a.discount_pct || 0));
  } else {
    out.sort((a, b) => Number(b.listing_id || b.promotion_id || 0) - Number(a.listing_id || a.promotion_id || 0));
  }
  return out;
}
