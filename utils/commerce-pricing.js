import prisma from './prisma-client.js';
import { PLATFORM_FEE_PERCENTAGE, getRegionData } from './tax-config.js';
import { effectivePrice } from './discount.js';
import { DEFAULT_DELIVERY_FEE, DEFAULT_SHIP_BY_SELLER_FEE } from './shop-constants.js';
import { quoteShipping, DEFAULT_LOCAL_RADIUS_KM } from './shop-shipping-zones.js';
import { resolveFoodDeliveryFee } from './food-delivery-pricing.js';
import { validatePromotionForUser } from './promotion.js';
import { verticalForVendorTypeName } from './vendor-type.js';

export const SHIPPING_FEES = {
  delivery: DEFAULT_DELIVERY_FEE,
  ship_by_seller: DEFAULT_SHIP_BY_SELLER_FEE,
};

export function detectCartSource(items, hint) {
  if (hint === 'digital' || hint === 'product' || hint === 'food') return hint;
  const first = items[0] || {};
  if (first.content_id != null) return 'digital';
  if (first.variation_id != null || first.listing_id != null) return 'product';
  if (first.food_item_id != null) return 'food';
  return null;
}

export function normalizeModifierOptionIds(value) {
  if (!Array.isArray(value)) return [];
  const ids = [];
  const seen = new Set();
  for (const raw of value) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    ids.push(id);
    seen.add(id);
  }
  return ids;
}

function hasInvalidModifierOptionId(value) {
  return Array.isArray(value) && value.some((raw) => {
    const id = Number(raw);
    return !Number.isInteger(id) || id <= 0;
  });
}

export async function resolveFoodCartLines(items, tx = prisma) {
  const ids = [...new Set(items.map((i) => Number(i.food_item_id)).filter(Number.isInteger))];
  if (!ids.length) return { ok: false, fallback: true };
  const rows = await tx.food_item.findMany({
    where: { food_item_id: { in: ids } },
    select: { food_item_id: true, price: true, vendor_id: true, vendor_type_id: true },
  });
  const itemById = new Map(rows.map((r) => [r.food_item_id, r]));

  const optIds = [...new Set(
    items.flatMap((i) => normalizeModifierOptionIds(i.modifier_option_ids))
  )];
  const optRows = optIds.length
    ? await tx.food_item_modifier_option.findMany({
        where: { option_id: { in: optIds }, is_available: true },
        select: { option_id: true, price: true, group: { select: { food_item_id: true } } },
      })
    : [];
  const optById = new Map(optRows.map((o) => [o.option_id, {
    price: Number(o.price) || 0,
    foodItemId: o.group?.food_item_id ?? null,
  }]));

  const lines = [];
  for (const it of items) {
    const foodItemId = Number(it.food_item_id);
    const row = itemById.get(foodItemId);
    if (!row) return { ok: false, fallback: true };
    const qty = Number(it.qty ?? 1);
    if (!Number.isInteger(qty) || qty <= 0) {
      return { ok: false, error: `Invalid quantity for food_item_id ${foodItemId}` };
    }
    if (hasInvalidModifierOptionId(it.modifier_option_ids)) {
      return { ok: false, error: `Invalid modifier option for food_item_id ${foodItemId}` };
    }
    const modifierOptionIds = normalizeModifierOptionIds(it.modifier_option_ids);
    let price = Number(row.price) || 0;
    for (const oid of modifierOptionIds) {
      const opt = optById.get(oid);
      if (!opt || opt.foodItemId !== foodItemId) {
        return { ok: false, error: `Unknown or invalid modifier option ${oid}` };
      }
      price += opt.price;
    }
    lines.push({
      food_item_id: foodItemId,
      qty,
      price,
      vendor_id: row.vendor_id ?? null,
      vendor_type_id: row.vendor_type_id ?? null,
      modifier_option_ids: modifierOptionIds,
      special_instructions: typeof it.special_instructions === 'string' ? it.special_instructions.trim() : null,
    });
  }
  return { ok: true, lines };
}

export async function resolveLinePrices(items, source, tx = prisma) {
  const qtyOf = (it) => Math.max(1, Number(it.qty) || 1);
  if (source === 'digital') {
    const ids = [...new Set(items.map((i) => Number(i.content_id)).filter(Number.isInteger))];
    if (!ids.length) return { ok: false, error: 'No valid items in cart' };
    const rows = await tx.dg_content.findMany({ where: { content_id: { in: ids } }, select: { content_id: true, price: true } });
    const priceById = new Map(rows.map((r) => [r.content_id, Number(r.price) || 0]));
    const lines = [];
    for (const it of items) {
      if (!priceById.has(Number(it.content_id))) return { ok: false, error: `Unknown content_id ${it.content_id}` };
      lines.push({ qty: qtyOf(it), price: priceById.get(Number(it.content_id)) });
    }
    return { ok: true, lines };
  }
  if (source === 'product') {
    const varIds = [...new Set(items.map((i) => Number(i.variation_id)).filter(Number.isInteger))];
    const listingIds = [...new Set(items.filter((i) => i.variation_id == null).map((i) => Number(i.listing_id)).filter(Number.isInteger))];
    const varRows = varIds.length
      ? await tx.product_variation.findMany({ where: { variation_id: { in: varIds } }, select: { variation_id: true, price: true, discount_pct: true } })
      : [];
    const priceByVar = new Map(varRows.map((r) => [r.variation_id, effectivePrice(Number(r.price) || 0, r.discount_pct)]));
    const listVarRows = listingIds.length
      ? await tx.product_variation.findMany({ where: { listing_id: { in: listingIds } }, select: { variation_id: true, listing_id: true, price: true, discount_pct: true }, orderBy: { variation_id: 'asc' } })
      : [];
    const priceByListing = new Map();
    for (const r of listVarRows) if (!priceByListing.has(r.listing_id)) priceByListing.set(r.listing_id, effectivePrice(Number(r.price) || 0, r.discount_pct));
    const lines = [];
    for (const it of items) {
      let price;
      if (it.variation_id != null && priceByVar.has(Number(it.variation_id))) price = priceByVar.get(Number(it.variation_id));
      else if (it.listing_id != null && priceByListing.has(Number(it.listing_id))) price = priceByListing.get(Number(it.listing_id));
      if (price == null) return { ok: false, fallback: true };
      lines.push({ qty: qtyOf(it), price });
    }
    return { ok: true, lines };
  }
  if (source === 'food') return resolveFoodCartLines(items, tx);
  return { ok: false, fallback: true };
}

export function totalFromLines({ lines, country, tip = 0, shippingMode, shippingFee = null, promoDiscount = 0 }) {
  const grossSubtotal = lines.reduce((s, l) => s + (Number(l.price) || 0) * Math.max(1, Number(l.qty) || 1), 0);
  // A promo reduces the merchandise base BEFORE fee + tax, so the platform fee and
  // the taxable amount follow what the buyer is actually charged (and match the
  // total the checkout screen quoted). Discounting the final sum instead would tax
  // money nobody paid and leave the quote, the charge and the order row disagreeing.
  const discount = Math.min(grossSubtotal, Math.max(0, Number(promoDiscount) || 0));
  const subtotal = grossSubtotal - discount;
  const platformFee = subtotal * PLATFORM_FEE_PERCENTAGE;
  const taxRate = Number(getRegionData(country)?.tax) || 0;
  const tax = (subtotal + platformFee) * taxRate;
  const shipping =
    shippingFee != null && Number.isFinite(Number(shippingFee))
      ? Math.max(0, Number(shippingFee))
      : SHIPPING_FEES[shippingMode] || 0;
  const safeTip = Math.max(0, Number(tip) || 0);
  const amount = parseFloat((subtotal + platformFee + tax + shipping + safeTip).toFixed(2));
  return {
    amount,
    enforcement: 'exact',
    shipping,
    subtotal: Number(subtotal.toFixed(2)),
    grossSubtotal: Number(grossSubtotal.toFixed(2)),
    promoDiscount: Number(discount.toFixed(2)),
    platformFee: Number(platformFee.toFixed(2)),
    tax: Number(tax.toFixed(2)),
    tip: Number(safeTip.toFixed(2)),
  };
}

export async function resolveCommerceShippingFee({
  sellerId,
  shippingMode,
  country,
  city,
  lat,
  lng,
}) {
  if (shippingMode === 'pickup' || shippingMode === 'digital') {
    return { ok: true, fee: 0, mode: shippingMode || 'pickup', local: true };
  }
  if (sellerId == null) {
    return {
      ok: true,
      fee: SHIPPING_FEES[shippingMode] || 0,
      mode: shippingMode,
      local: null,
    };
  }

  const store = await prisma.store_profile.findUnique({
    where: { user_id: Number(sellerId) },
    include: {
      shipping_zones: {
        where: { is_active: true },
        orderBy: [{ priority: 'asc' }, { zone_id: 'asc' }],
      },
    },
  });
  if (!store) {
    return {
      ok: true,
      fee: SHIPPING_FEES[shippingMode] || 0,
      mode: shippingMode,
      local: null,
    };
  }

  const quote = quoteShipping({
    store,
    zones: store.shipping_zones,
    buyer: {
      country: country ?? null,
      city: city ?? null,
      lat: lat != null ? Number(lat) : null,
      lng: lng != null ? Number(lng) : null,
    },
    preferredMode: shippingMode || null,
    localRadiusKm: DEFAULT_LOCAL_RADIUS_KM,
  });

  if (!quote.ok) {
    return { ok: false, error: quote.error || 'Shipping not available', fee: null, mode: null };
  }
  return {
    ok: true,
    fee: quote.fee,
    mode: quote.mode,
    local: quote.local,
    zone_id: quote.zone_id,
  };
}

/**
 * Server-side promo discount for a commerce cart, using the same validator the
 * order-create routes use so the charge and the persisted order agree.
 *
 * Only food + product carts are discounted here: those are the order rows that
 * store `promo_code` / `promo_discount`. Digital (dg_order / book order) carts
 * have no promo column, so discounting the charge would under-collect against
 * the order we save.
 */
async function resolveCartPromoDiscount({ promoCode, userId, source, lines }) {
  const code = String(promoCode || '').trim();
  if (!code || (source !== 'food' && source !== 'product')) {
    return { ok: true, amount: 0, code: null };
  }
  const subtotal = lines.reduce(
    (s, l) => s + (Number(l.price) || 0) * Math.max(1, Number(l.qty) || 1),
    0,
  );

  let vendorId = null;
  let vendorOwnerId = null;
  let promoVertical = source === 'food' ? 'food' : 'discounts';
  if (source === 'food') {
    const vendorIds = [...new Set(lines.map((line) => line.vendor_id).filter((id) => id != null))];
    vendorId = vendorIds.length === 1 ? Number(vendorIds[0]) : null;
    if (vendorId != null) {
      const vendor = await prisma.food_vendor.findUnique({
        where: { vendor_id: vendorId },
        select: { owner_id: true, vendor_type: { select: { vendor_type: true } } },
      });
      vendorOwnerId = vendor?.owner_id ?? null;
      const mapped = verticalForVendorTypeName(vendor?.vendor_type?.vendor_type);
      if (mapped) promoVertical = mapped;
    }
  }

  const validated = await validatePromotionForUser({
    code,
    userId,
    subtotal,
    vertical: promoVertical,
    vendorId,
    vendorOwnerId,
  });
  if (!validated.ok) {
    return {
      ok: false,
      error: validated.message || 'Invalid promo code.',
      status: validated.status || 400,
    };
  }
  return { ok: true, amount: Number(validated.amount) || 0, code: validated.code };
}

export async function computeCommerceCartAmount({
  items,
  country,
  tip = 0,
  shippingMode,
  source,
  sellerId = null,
  city = null,
  lat = null,
  lng = null,
  deliveryLocation = null,
  shippingFee = null,
  promoCode = null,
  userId = null,
}) {
  if (!Array.isArray(items) || !items.length) return { ok: false, fallback: true };
  const src = detectCartSource(items, source);
  if (!src) return { ok: false, fallback: true };
  const resolved = await resolveLinePrices(items, src);
  if (!resolved.ok) return { ok: false, fallback: resolved.fallback === true, error: resolved.error };

  let feeOverride = shippingFee;
  let mode = shippingMode;
  if (feeOverride == null && src === 'food') {
    const vendorIds = [...new Set(resolved.lines.map((line) => line.vendor_id).filter((id) => id != null))];
    if (vendorIds.length > 1) {
      return { ok: false, fallback: false, error: 'Food cart cannot contain items from multiple restaurants' };
    }
    const vendorId = vendorIds[0] ?? null;
    const vendor = vendorId != null
      ? await prisma.food_vendor.findUnique({ where: { vendor_id: Number(vendorId) }, select: { location: true } })
      : null;
    const resolvedDeliveryLocation =
      deliveryLocation ||
      (lat != null && lng != null ? `${lat},${lng}` : null) ||
      city ||
      null;
    feeOverride = await resolveFoodDeliveryFee({
      vendorLocation: vendor?.location,
      deliverLocation: resolvedDeliveryLocation,
    });
    mode = mode || 'delivery';
  } else if (feeOverride == null && sellerId != null) {
    const ship = await resolveCommerceShippingFee({
      sellerId,
      shippingMode,
      country,
      city,
      lat,
      lng,
    });
    if (!ship.ok) return { ok: false, fallback: false, error: ship.error };
    feeOverride = ship.fee;
    mode = ship.mode || shippingMode;
  }

  const promo = await resolveCartPromoDiscount({
    promoCode,
    userId,
    source: src,
    lines: resolved.lines,
  });
  if (!promo.ok) {
    return { ok: false, fallback: false, error: promo.error, status: promo.status };
  }

  const { amount, enforcement, shipping } = totalFromLines({
    lines: resolved.lines,
    country,
    tip,
    shippingMode: mode,
    shippingFee: feeOverride,
    promoDiscount: promo.amount,
  });
  return {
    ok: true,
    amount,
    enforcement,
    source: src,
    shipping,
    shippingMode: mode,
    promoDiscount: promo.amount,
    promoCode: promo.code,
  };
}

export const __test = { detectCartSource };
