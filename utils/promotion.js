import prisma from './prisma-client.js';
import {
  classifyCustomerAgainstVendorOrders,
  customerMatchesAudienceSegment,
  normalizeAudienceSegment,
} from './customer-analytics.js';

const PROMO_VERTICAL_ALIAS = { groceries: 'grocery', flowers: 'floral', restaurants: 'food', restaurant: 'food' };
function canonicalPromoVertical(vertical) {
  const v = String(vertical || '').trim().toLowerCase();
  if (!v) return null;
  return PROMO_VERTICAL_ALIAS[v] || v;
}

const FOOD_FAMILY_VERTICALS = new Set(['food', 'grocery', 'liquor', 'pharmacy', 'floral', 'catering', 'mealkit', 'meal_kit']);
export function isFoodFamilyVertical(vertical) {
  const v = canonicalPromoVertical(vertical);
  return v != null && FOOD_FAMILY_VERTICALS.has(v);
}

/** Block audience_segment on shop/decor/wedding — enforcement only exists for food-family. */
export function rejectAudienceSegmentForVertical(vertical, audienceSegment) {
  const segment = audienceSegment != null && String(audienceSegment).trim() !== ''
    ? normalizeAudienceSegment(audienceSegment)
    : null;
  if (!segment) return { ok: true, segment: null };
  if (!isFoodFamilyVertical(vertical)) {
    return {
      ok: false,
      message: 'Audience-targeted offers are only supported for food-family verticals.',
    };
  }
  return { ok: true, segment };
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export function normalizePromoCode(code) {
  return String(code || '').trim().toUpperCase();
}

export function computePromoDiscount(promo, subtotal) {
  const base = Math.max(0, Number(subtotal) || 0);
  const value = Number(promo.discount_value) || 0;
  if (String(promo.discount_type).toLowerCase() === 'percent') {
    return round2(Math.min(base, base * (Math.min(95, value) / 100)));
  }
  return round2(Math.min(base, value));
}

/**
 * Resolve Opportunities audience for a promo.
 * Prefers DB audience_segment. Prefix fallback only matches Opportunities generators
 * (VIP12…, FIRST15…, WIN15…, BACK20… — PREFIX + digit). Plain codes like WINTER25 or
 * BACKTOSCHOOL must NOT inherit an audience, or shop checkout 400s them as "restaurant only".
 */
export function resolvePromotionAudienceSegment(promo) {
  const fromField = normalizeAudienceSegment(promo?.audience_segment);
  if (fromField) return fromField;
  const code = String(promo?.code || '').trim().toUpperCase();
  if (!code) return null;
  // Require a digit right after the generator prefix (suggested % in Opportunities codes).
  const m = /^(VIP|FIRST|UPSELL|WIN|BACK|AGAIN)(\d)/.exec(code);
  if (!m) return null;
  const prefix = m[1];
  if (prefix === 'VIP') return 'vip';
  if (prefix === 'FIRST') return 'prospects';
  if (prefix === 'UPSELL') return 'recent';
  if (prefix === 'WIN') return 'atrisk';
  if (prefix === 'BACK') return 'churned';
  if (prefix === 'AGAIN') return 'oneshot';
  return null;
}

function formatDiscountLabel(promo) {
  const value = Number(promo?.discount_value);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (String(promo?.discount_type).toLowerCase() === 'percent') {
    return `${Math.round(value)}% OFF`;
  }
  return `$${value} OFF`;
}

/** Buyer-facing badge — never expose raw promo codes. */
export function formatOfferBadge(promo) {
  if (!promo) return null;
  const segment = resolvePromotionAudienceSegment(promo);
  const pctLabel = formatDiscountLabel(promo);
  if (!segment || !pctLabel) return null;
  if (segment === 'prospects') return `First order — ${pctLabel}`;
  if (segment === 'recent') return `Welcome back — ${pctLabel}`;
  if (segment === 'vip') return `VIP — ${pctLabel}`;
  if (segment === 'atrisk') return `Win back — ${pctLabel}`;
  if (segment === 'churned') return `Come back — ${pctLabel}`;
  if (segment === 'oneshot') return `Second order — ${pctLabel}`;
  return null;
}

export async function refreshPromotionStatus(promo, now = new Date()) {
  if (!promo) return promo;
  let next = promo.status;
  if (['disabled', 'expired'].includes(String(promo.status || '').toLowerCase())) return promo;
  if (promo.ends_at && new Date(promo.ends_at) < now) next = 'expired';
  else if (promo.starts_at && new Date(promo.starts_at) > now) next = 'scheduled';
  else if (['draft', 'scheduled', 'active'].includes(String(promo.status || '').toLowerCase())) {
    if ((!promo.starts_at || new Date(promo.starts_at) <= now)
      && (!promo.ends_at || new Date(promo.ends_at) >= now)) {
      next = promo.status === 'draft' ? promo.status : 'active';
    }
  }
  if (promo.quantity_limit != null && Number(promo.claimed_count || 0) >= Number(promo.quantity_limit)) {
    next = 'expired';
  }
  if (next !== promo.status) {
    return prisma.promotion.update({
      where: { promotion_id: promo.promotion_id },
      data: { status: next },
    });
  }
  return promo;
}

export async function findPromotionByCode(code) {
  const normalized = normalizePromoCode(code);
  if (!normalized) return null;
  const promo = await prisma.promotion.findUnique({ where: { code: normalized } });
  if (!promo) return null;
  return refreshPromotionStatus(promo);
}

async function loadVendorPaidOrders(vendorId) {
  if (vendorId == null) return [];
  const rows = await prisma.food_order.findMany({
    where: { vendor_id: Number(vendorId), ispaid: true },
    select: { user_id: true, created_at: true, total_amount: true },
  });
  return rows
    .filter((r) => r.user_id != null)
    .map((r) => ({
      customer_id: r.user_id,
      at: r.created_at,
      amount: Number(r.total_amount) || 0,
    }));
}

/**
 * Validate a promo for checkout / apply.
 * Optional: vendorOwnerId + vendorId enforce seller ownership + Opportunities audience rules.
 */
export async function validatePromotionForUser({
  code,
  userId = null,
  subtotal = 0,
  vertical = null,
  vendorOwnerId = null,
  vendorId = null,
}) {
  const promo = await findPromotionByCode(code);
  if (!promo) return { ok: false, status: 404, message: 'Invalid promo code.' };
  const status = String(promo.status || '').toLowerCase();
  if (status === 'draft') return { ok: false, status: 404, message: 'Invalid promo code.' };
  if (status === 'scheduled') return { ok: false, status: 400, message: 'This promo is not active yet.' };
  if (status === 'expired' || status === 'disabled') {
    return { ok: false, status: 400, message: 'This promo has expired or been disabled.' };
  }
  if (status !== 'active') return { ok: false, status: 400, message: 'This promo is not available.' };

  const now = new Date();
  if (promo.starts_at && new Date(promo.starts_at) > now) {
    return { ok: false, status: 400, message: 'This promo is not active yet.' };
  }
  if (promo.ends_at && new Date(promo.ends_at) < now) {
    return { ok: false, status: 400, message: 'This promo has expired.' };
  }
  if (promo.max_redemptions != null) {
    const total = await prisma.promotion_redemption.count({ where: { promotion_id: promo.promotion_id } });
    if (total >= Number(promo.max_redemptions)) {
      return { ok: false, status: 400, message: 'This promo has reached its redemption limit.' };
    }
  }
  if (promo.quantity_limit != null && Number(promo.claimed_count || 0) >= Number(promo.quantity_limit)) {
    return { ok: false, status: 400, message: 'This promo is sold out.' };
  }
  if (userId != null && promo.per_user_limit != null) {
    const used = await prisma.promotion_redemption.count({
      where: { promotion_id: promo.promotion_id, user_id: Number(userId) },
    });
    if (used >= Number(promo.per_user_limit)) {
      return { ok: false, status: 400, message: 'You have already used this promo the maximum number of times.' };
    }
  }
  const minOrder = Number(promo.min_order_amount || 0);
  if (minOrder > 0 && Number(subtotal || 0) > 0 && Number(subtotal) < minOrder) {
    return { ok: false, status: 400, message: `Minimum order of $${minOrder} required for this promo.` };
  }
  if (promo.vertical && vertical && String(promo.vertical).toLowerCase() !== String(vertical).toLowerCase()) {
    return { ok: false, status: 400, message: 'This promo does not apply to this vertical.' };
  }

  // Seller-scoped food promos must belong to the restaurant owner.
  if (
    vendorOwnerId != null
    && promo.owner_user_id != null
    && String(promo.scope || '').toLowerCase() === 'seller'
    && Number(promo.owner_user_id) !== Number(vendorOwnerId)
  ) {
    return { ok: false, status: 400, message: 'This promo is not valid at this restaurant.' };
  }

  // Audience gating is for Opportunities seller offers (explicit segment or seller scope).
  // Never force a restaurant context on a platform shop promo just because its code
  // happens to look like WIN… / BACK… (see resolvePromotionAudienceSegment).
  const explicitSegment = normalizeAudienceSegment(promo?.audience_segment);
  const segment = resolvePromotionAudienceSegment(promo);
  const enforceAudience = Boolean(
    explicitSegment
    || (segment && String(promo.scope || '').toLowerCase() === 'seller'),
  );
  if (enforceAudience && segment) {
    if (userId == null) {
      return { ok: false, status: 401, message: 'Sign in to use this offer.' };
    }
    if (vendorId == null) {
      return { ok: false, status: 400, message: 'This offer requires a restaurant context.' };
    }
    const vendorOrders = await loadVendorPaidOrders(vendorId);
    const flags = classifyCustomerAgainstVendorOrders(userId, vendorOrders);
    if (!customerMatchesAudienceSegment(flags, segment)) {
      const messages = {
        prospects: 'This first-order offer is only for customers who have not ordered here yet.',
        recent: 'This upsell offer is only for recent customers of this restaurant.',
        vip: 'This VIP reward is only for top customers of this restaurant.',
        atrisk: 'This win-back offer is not available for your account right now.',
        churned: 'This re-activation offer is not available for your account right now.',
        oneshot: 'This second-order offer is only for one-time customers.',
      };
      return { ok: false, status: 400, message: messages[segment] || 'You are not eligible for this offer.' };
    }
  }

  const amount = computePromoDiscount(promo, subtotal);
  return {
    ok: true,
    promo,
    amount,
    type: promo.discount_type,
    value: Number(promo.discount_value),
    label: promo.title || `${promo.code} applied`,
    code: promo.code,
    badge: formatOfferBadge(promo),
  };
}

export async function redeemPromotion({
  promotionId,
  userId,
  amount,
  orderId = null,
  orderRef = null,
}) {
  return prisma.$transaction(async (tx) => {
    const promo = await tx.promotion.findUnique({ where: { promotion_id: Number(promotionId) } });
    if (!promo) return { ok: false, message: 'Promotion not found' };
    if (promo.quantity_limit != null && Number(promo.claimed_count || 0) >= Number(promo.quantity_limit)) {
      return { ok: false, message: 'Promotion sold out' };
    }
    const redemption = await tx.promotion_redemption.create({
      data: {
        promotion_id: promo.promotion_id,
        user_id: Number(userId),
        order_id: orderId != null ? Number(orderId) : null,
        order_ref: orderRef || null,
        amount: Number(amount) || 0,
      },
    });
    await tx.promotion.update({
      where: { promotion_id: promo.promotion_id },
      data: {
        claimed_count: { increment: 1 },
        ...(promo.quantity_limit != null && Number(promo.claimed_count || 0) + 1 >= Number(promo.quantity_limit)
          ? { status: 'expired' }
          : {}),
      },
    });
    return { ok: true, redemption };
  });
}

export function serializePromotion(promo) {
  if (!promo) return null;
  return {
    promotion_id: promo.promotion_id,
    code: promo.code,
    title: promo.title,
    description: promo.description,
    kind: promo.kind,
    discount_type: promo.discount_type,
    discount_value: Number(promo.discount_value),
    status: promo.status,
    starts_at: promo.starts_at,
    ends_at: promo.ends_at,
    max_redemptions: promo.max_redemptions,
    per_user_limit: promo.per_user_limit,
    min_order_amount: promo.min_order_amount,
    quantity_limit: promo.quantity_limit,
    claimed_count: promo.claimed_count,
    scope: promo.scope,
    vertical: promo.vertical,
    category: promo.category,
    geo_city: promo.geo_city,
    audience_segment: resolvePromotionAudienceSegment(promo),
    offer_title: formatOfferBadge(promo),
    is_featured: promo.is_featured,
    report_count: promo.report_count,
    owner_user_id: promo.owner_user_id,
    created_at: promo.created_at,
  };
}

const SEGMENT_PRIORITY = ['vip', 'recent', 'prospects', 'oneshot', 'atrisk', 'churned'];

function isPromoWindowActive(promo, now = new Date()) {
  const status = String(promo.status || '').toLowerCase();
  if (status !== 'active') return false;
  if (promo.starts_at && new Date(promo.starts_at) > now) return false;
  if (promo.ends_at && new Date(promo.ends_at) < now) return false;
  if (promo.quantity_limit != null && Number(promo.claimed_count || 0) >= Number(promo.quantity_limit)) return false;
  return true;
}

/**
 * Attach eligible_offers / offer_title / discount_badge onto food vendor payloads.
 * Batches promo + order lookups for browse lists.
 */
export async function attachFoodVendorOffers(vendors, userId = null) {
  const list = Array.isArray(vendors) ? vendors : [];
  if (!list.length) return list;

  const ownerIds = [...new Set(list.map((v) => v?.owner_id).filter((id) => id != null).map(Number))];
  const vendorIds = [...new Set(list.map((v) => v?.vendor_id).filter((id) => id != null && !String(id).startsWith('ad_')).map(Number))];

  if (!ownerIds.length) {
    return list.map((v) => ({
      ...v,
      eligible_offers: [],
      offer_title: null,
      discount_badge: null,
      promo_badge: null,
    }));
  }

  const now = new Date();
  const promos = await prisma.promotion.findMany({
    where: {
      owner_user_id: { in: ownerIds },
      status: 'active',
      OR: [{ vertical: null }, { vertical: { in: [...FOOD_FAMILY_VERTICALS] } }],
      AND: [
        { OR: [{ starts_at: null }, { starts_at: { lte: now } }] },
        { OR: [{ ends_at: null }, { ends_at: { gte: now } }] },
      ],
    },
  });
  const activePromos = promos.filter((p) => isPromoWindowActive(p, now));
  const byOwner = new Map();
  for (const p of activePromos) {
    const oid = Number(p.owner_user_id);
    if (!byOwner.has(oid)) byOwner.set(oid, []);
    byOwner.get(oid).push(p);
  }

  let ordersByVendor = new Map();
  if (userId != null && vendorIds.length) {
    const orderRows = await prisma.food_order.findMany({
      where: { vendor_id: { in: vendorIds }, ispaid: true },
      select: { vendor_id: true, user_id: true, created_at: true, total_amount: true },
    });
    for (const row of orderRows) {
      if (row.user_id == null || row.vendor_id == null) continue;
      const vid = Number(row.vendor_id);
      if (!ordersByVendor.has(vid)) ordersByVendor.set(vid, []);
      ordersByVendor.get(vid).push({
        customer_id: row.user_id,
        at: row.created_at,
        amount: Number(row.total_amount) || 0,
      });
    }
  }

  return list.map((vendor) => {
    if (vendor?.is_ad && vendor?.is_generic_ad) {
      return { ...vendor, eligible_offers: [], offer_title: null, discount_badge: null, promo_badge: null };
    }
    const ownerId = vendor?.owner_id != null ? Number(vendor.owner_id) : null;
    const vendorId = vendor?.vendor_id != null && !String(vendor.vendor_id).startsWith('ad_')
      ? Number(vendor.vendor_id)
      : null;
    const ownerPromos = ownerId != null ? (byOwner.get(ownerId) || []) : [];
    const vendorVertical = canonicalPromoVertical(vendor?.vendor_type?.vendor_type)
      || canonicalPromoVertical(vendor?.vertical);
    const flags = userId != null && vendorId != null
      ? classifyCustomerAgainstVendorOrders(userId, ordersByVendor.get(vendorId) || [])
      : { prospects: true, recent: false, vip: false, atrisk: false, churned: false, oneshot: false };

    const eligible = [];
    for (const promo of ownerPromos) {
      const promoVertical = canonicalPromoVertical(promo.vertical);
      if (promoVertical && vendorVertical && promoVertical !== vendorVertical) continue;
      const segment = resolvePromotionAudienceSegment(promo);
      // Opportunities badges require a known audience — never show raw codes / unscoped promos.
      if (!segment) continue;

      if (userId == null) {
        // Guests: only first-order teasers (anyone might be new here).
        if (segment !== 'prospects') continue;
      } else if (!customerMatchesAudienceSegment(flags, segment)) {
        continue;
      }

      const badge = formatOfferBadge(promo);
      if (!badge) continue;

      eligible.push({
        promotion_id: promo.promotion_id,
        code: promo.code,
        title: promo.title,
        audience_segment: segment,
        discount_type: promo.discount_type,
        discount_value: Number(promo.discount_value),
        offer_title: badge,
        ends_at: promo.ends_at,
        min_order_amount: promo.min_order_amount,
      });
    }

    eligible.sort((a, b) => {
      const pa = SEGMENT_PRIORITY.indexOf(a.audience_segment || '');
      const pb = SEGMENT_PRIORITY.indexOf(b.audience_segment || '');
      return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
    });

    const top = eligible[0] || null;
    return {
      ...vendor,
      eligible_offers: eligible,
      offer_title: top?.offer_title || null,
      discount_badge: top?.offer_title || null,
      promo_badge: top?.offer_title || null,
    };
  });
}
