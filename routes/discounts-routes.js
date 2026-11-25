import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken, optionalAuth } from '../middleware/authentication.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { clampDiscountPct } from '../utils/discount.js';
import {
  filterDeals,
  isMarkdownWindowActive,
  mapListingToDeal,
  mapPromotionToDeal,
} from '../utils/discount-feed.js';
import {
  serializePromotion,
  validatePromotionForUser,
  redeemPromotion,
  refreshPromotionStatus,
  normalizePromoCode,
  rejectAudienceSegmentForVertical,
} from '../utils/promotion.js';
import { normalizeAudienceSegment } from '../utils/customer-analytics.js';

const router = express.Router();

function isAdmin(req) {
  return req.user?.role === 'ADMIN' || req.user?.permission === 'admin';
}

function parseDate(v) {
  if (v == null || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* POST VALIDATE PROMO CODE — DB-backed coupons with window/cap checks */
// Rate-limited to stop anonymous brute-force enumeration of valid promo codes.
router.post('/validate', optionalAuth, rateLimit({ windowSec: 60, max: 30, keyPrefix: 'promo-validate' }), async (req, res) => {
  try {
    const { code, promotion_id, subtotal, vertical, vendor_id, vendor_owner_id } = req.body || {};
    // Browse cards carry only `promotion_id` (never the raw code — see attachFoodVendorOffers),
    // so resolve the code here, behind this rate-limited endpoint, instead of leaking it publicly.
    let resolvedCode = code;
    if (!resolvedCode && promotion_id != null) {
      const byId = await prisma.promotion.findUnique({
        where: { promotion_id: Number(promotion_id) },
        select: { code: true },
      });
      resolvedCode = byId?.code || null;
    }
    if (!resolvedCode) return res.status(400).json({ valid: false, message: 'No code provided.' });
    const userId = req.user?.user_id || null;
    const result = await validatePromotionForUser({
      code: resolvedCode,
      userId,
      subtotal: Number(subtotal) || 0,
      vertical: vertical || null,
      vendorId: vendor_id != null ? Number(vendor_id) : null,
      vendorOwnerId: vendor_owner_id != null ? Number(vendor_owner_id) : null,
    });
    if (!result.ok) {
      return res.status(result.status || 400).json({ valid: false, message: result.message });
    }
    return res.json({
      valid: true,
      type: result.type,
      value: result.value,
      label: result.label,
      code: result.code,
      amount: result.amount,
      badge: result.badge || null,
      promotion_id: result.promo.promotion_id,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ valid: false, message: 'Failed to validate promo code' });
  }
});

/* GET ACTIVE DISCOUNTS — cross-category sale feed + active coupon/deal promos */
router.get('/', async (req, res) => {
  try {
    const now = new Date();
    const take = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 80));
    const includePromos = String(req.query.include_promos || 'true').toLowerCase() !== 'false';

    const listings = await prisma.product_listing.findMany({
      where: {
        seller_id: { not: null },
        product_variation: { some: { discount_pct: { gt: 0 } } },
      },
      orderBy: { listing_id: 'desc' },
      take: 200,
      include: {
        product_type: true,
        product_variation: { orderBy: { variation_id: 'asc' } },
      },
    });

    const saleDeals = listings
      .map((l) => mapListingToDeal(l, now))
      .filter(Boolean);

    let promoDeals = [];
    if (includePromos) {
      const promos = await prisma.promotion.findMany({
        where: {
          status: { in: ['active', 'scheduled'] },
          kind: { in: ['coupon', 'deal'] },
          // Opportunities (targeted seller coupons) must not land on the unauthenticated
          // discounts feed — that would republish live codes after we stripped them from
          // GET /food/vendors. Public feed is platform/unscoped coupons only.
          audience_segment: null,
        },
        orderBy: [{ is_featured: 'desc' }, { promotion_id: 'desc' }],
        take: 100,
      });
      for (const p of promos) {
        const refreshed = await refreshPromotionStatus(p, now);
        const live = String(refreshed.status || '').toLowerCase() === 'active'
          && (!refreshed.starts_at || new Date(refreshed.starts_at) <= now)
          && (!refreshed.ends_at || new Date(refreshed.ends_at) >= now);
        if (!live) continue;
        promoDeals.push(mapPromotionToDeal(refreshed));
      }
    }

    const filtered = filterDeals([...saleDeals, ...promoDeals], req.query).slice(0, take);
    res.json(filtered);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch discounts' });
  }
});

/* GET seller markdown inventory (owned on-sale listings) */
router.get('/mine', authenticateToken, async (req, res) => {
  try {
    const listings = await prisma.product_listing.findMany({
      where: {
        seller_id: req.user.user_id,
        product_variation: { some: { discount_pct: { gt: 0 } } },
      },
      orderBy: { listing_id: 'desc' },
      include: {
        product_type: true,
        product_variation: { orderBy: { variation_id: 'asc' } },
      },
    });
    const now = new Date();
    res.json(listings.map((l) => {
      const deal = mapListingToDeal(l, now);
      const v = l.product_variation.find((x) => clampDiscountPct(x.discount_pct) > 0) || l.product_variation[0];
      return {
        ...deal,
        active_now: v ? isMarkdownWindowActive(v, now) : false,
        discount_starts_at: v?.discount_starts_at || null,
        discount_ends_at: v?.discount_ends_at || null,
      };
    }).filter(Boolean));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch your discounts' });
  }
});

/* GET seller promotions */
router.get('/promotions/mine', authenticateToken, async (req, res) => {
  try {
    const rows = await prisma.promotion.findMany({
      where: { owner_user_id: req.user.user_id },
      orderBy: { promotion_id: 'desc' },
    });
    res.json(rows.map(serializePromotion));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch promotions' });
  }
});

/* GET seller analytics */
router.get('/analytics/mine', authenticateToken, async (req, res) => {
  try {
    const ownerId = req.user.user_id;
    const [activeSales, promos, redemptions] = await Promise.all([
      prisma.product_listing.count({
        where: {
          seller_id: ownerId,
          product_variation: { some: { discount_pct: { gt: 0 } } },
        },
      }),
      prisma.promotion.findMany({ where: { owner_user_id: ownerId } }),
      prisma.promotion_redemption.findMany({
        where: { promotion: { owner_user_id: ownerId } },
        orderBy: { redemption_id: 'desc' },
        take: 50,
      }),
    ]);
    const spend = redemptions.reduce((s, r) => s + Number(r.amount || 0), 0);
    res.json({
      active_sales: activeSales,
      promotions: promos.length,
      active_promotions: promos.filter((p) => p.status === 'active').length,
      redemptions: redemptions.length,
      redemption_spend: Math.round(spend * 100) / 100,
      recent_redemptions: redemptions,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch discount analytics' });
  }
});

/* POST set/clear markdown on an owned product listing */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const {
      listing_id,
      variation_id,
      discount_pct,
      discount_starts_at,
      discount_ends_at,
    } = req.body || {};

    const listingId = Number(listing_id);
    if (!Number.isInteger(listingId)) {
      return res.status(400).json({ error: 'listing_id is required' });
    }

    const listing = await prisma.product_listing.findUnique({
      where: { listing_id: listingId },
      include: { product_variation: true, product_type: true },
    });
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    if (listing.seller_id !== req.user.user_id && !isAdmin(req)) {
      return res.status(403).json({ error: 'You do not own this listing' });
    }

    let target = null;
    if (variation_id != null) {
      target = listing.product_variation.find((v) => v.variation_id === Number(variation_id));
    } else {
      target = listing.product_variation[0] || null;
    }
    if (!target) return res.status(404).json({ error: 'No product variation found to discount' });

    const pct = discount_pct === null || discount_pct === '' || discount_pct === undefined
      ? 0
      : clampDiscountPct(discount_pct);

    const updated = await prisma.product_variation.update({
      where: { variation_id: target.variation_id },
      data: {
        discount_pct: pct || null,
        discount_starts_at: parseDate(discount_starts_at),
        discount_ends_at: parseDate(discount_ends_at),
      },
    });

    const refreshed = await prisma.product_listing.findUnique({
      where: { listing_id: listingId },
      include: { product_type: true, product_variation: { orderBy: { variation_id: 'asc' } } },
    });
    const deal = mapListingToDeal(refreshed);
    res.status(200).json({
      successful: true,
      variation: updated,
      deal,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update discount' });
  }
});

/* POST create a coupon/deal promotion */
router.post('/promotions', authenticateToken, async (req, res) => {
  try {
    const {
      code, title, description, kind = 'coupon', discount_type, discount_value,
      status = 'active', starts_at, ends_at, max_redemptions, per_user_limit,
      min_order_amount, quantity_limit, scope = 'seller', vertical, category, geo_city,
      audience_segment,
    } = req.body || {};

    const normalized = normalizePromoCode(code);
    if (!normalized) return res.status(400).json({ error: 'code is required' });
    const dtype = String(discount_type || '').toLowerCase();
    if (!['percent', 'fixed'].includes(dtype)) {
      return res.status(400).json({ error: 'discount_type must be percent or fixed' });
    }
    const dval = Number(discount_value);
    if (!Number.isFinite(dval) || dval <= 0) {
      return res.status(400).json({ error: 'discount_value must be a positive number' });
    }

    const allowedStatus = new Set(['draft', 'scheduled', 'active', 'disabled']);
    const nextStatus = allowedStatus.has(String(status).toLowerCase()) ? String(status).toLowerCase() : 'active';
    const segment = normalizeAudienceSegment(audience_segment);
    if (audience_segment != null && String(audience_segment).trim() !== '' && !segment) {
      return res.status(400).json({ error: 'Invalid audience_segment' });
    }
    const audienceGate = rejectAudienceSegmentForVertical(vertical, audience_segment);
    if (!audienceGate.ok) return res.status(400).json({ error: audienceGate.message });

    const created = await prisma.promotion.create({
      data: {
        code: normalized,
        title: title || normalized,
        description: description || null,
        kind: ['coupon', 'deal'].includes(String(kind)) ? kind : 'coupon',
        discount_type: dtype,
        discount_value: dval,
        owner_user_id: req.user.user_id,
        status: nextStatus,
        starts_at: parseDate(starts_at) || new Date(),
        ends_at: parseDate(ends_at),
        max_redemptions: max_redemptions != null ? Number(max_redemptions) : null,
        per_user_limit: per_user_limit != null ? Number(per_user_limit) : 1,
        min_order_amount: min_order_amount != null ? Number(min_order_amount) : 0,
        quantity_limit: quantity_limit != null ? Number(quantity_limit) : null,
        scope: scope || 'seller',
        vertical: vertical || null,
        category: category || null,
        geo_city: geo_city || null,
        audience_segment: segment,
      },
    });
    res.status(201).json(serializePromotion(created));
  } catch (err) {
    if (err?.code === 'P2002') return res.status(409).json({ error: 'Promo code already exists' });
    console.error(err);
    res.status(500).json({ error: 'Failed to create promotion' });
  }
});

/* PATCH update promotion */
router.patch('/promotions/:id', authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await prisma.promotion.findUnique({ where: { promotion_id: id } });
    if (!existing) return res.status(404).json({ error: 'Promotion not found' });
    if (existing.owner_user_id !== req.user.user_id && !isAdmin(req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const {
      title, description, status, starts_at, ends_at, max_redemptions,
      per_user_limit, min_order_amount, quantity_limit, category, vertical, geo_city,
      discount_type, discount_value, audience_segment,
    } = req.body || {};

    const data = {};
    if (title !== undefined) data.title = title;
    if (description !== undefined) data.description = description;
    if (status !== undefined) data.status = String(status).toLowerCase();
    if (starts_at !== undefined) data.starts_at = parseDate(starts_at);
    if (ends_at !== undefined) data.ends_at = parseDate(ends_at);
    if (max_redemptions !== undefined) data.max_redemptions = max_redemptions == null ? null : Number(max_redemptions);
    if (per_user_limit !== undefined) data.per_user_limit = Number(per_user_limit);
    if (min_order_amount !== undefined) data.min_order_amount = Number(min_order_amount);
    if (quantity_limit !== undefined) data.quantity_limit = quantity_limit == null ? null : Number(quantity_limit);
    if (category !== undefined) data.category = category;
    if (vertical !== undefined) data.vertical = vertical;
    if (geo_city !== undefined) data.geo_city = geo_city;
    if (discount_type !== undefined) data.discount_type = String(discount_type).toLowerCase();
    if (discount_value !== undefined) data.discount_value = Number(discount_value);
    if (audience_segment !== undefined) {
      if (audience_segment == null || audience_segment === '') {
        data.audience_segment = null;
      } else {
        const segment = normalizeAudienceSegment(audience_segment);
        if (!segment) return res.status(400).json({ error: 'Invalid audience_segment' });
        data.audience_segment = segment;
      }
    }

    const nextVertical = data.vertical !== undefined ? data.vertical : existing.vertical;
    const nextSegment = data.audience_segment !== undefined ? data.audience_segment : existing.audience_segment;
    const audienceGate = rejectAudienceSegmentForVertical(nextVertical, nextSegment);
    if (!audienceGate.ok) return res.status(400).json({ error: audienceGate.message });

    const updated = await prisma.promotion.update({ where: { promotion_id: id }, data });
    res.json(serializePromotion(updated));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update promotion' });
  }
});

/* POST report false discount */
router.post('/report', authenticateToken, async (req, res) => {
  try {
    const { promotion_id, listing_id, reason } = req.body || {};
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: 'reason is required' });
    }
    const report = await prisma.discount_report.create({
      data: {
        reporter_id: req.user.user_id,
        promotion_id: promotion_id != null ? Number(promotion_id) : null,
        listing_id: listing_id != null ? Number(listing_id) : null,
        reason: String(reason).trim(),
      },
    });
    if (promotion_id != null) {
      await prisma.promotion.update({
        where: { promotion_id: Number(promotion_id) },
        data: { report_count: { increment: 1 } },
      }).catch(() => {});
    }
    res.status(201).json({ successful: true, report });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to submit report' });
  }
});

/* POST redeem (internal/checkout helper — authenticated) */
router.post('/redeem', authenticateToken, async (req, res) => {
  try {
    const { code, subtotal, order_id, order_ref, vertical } = req.body || {};
    const validated = await validatePromotionForUser({
      code,
      userId: req.user.user_id,
      subtotal: Number(subtotal) || 0,
      vertical: vertical || null,
    });
    if (!validated.ok) {
      return res.status(validated.status || 400).json({ successful: false, message: validated.message });
    }
    const redeemed = await redeemPromotion({
      promotionId: validated.promo.promotion_id,
      userId: req.user.user_id,
      amount: validated.amount,
      orderId: order_id || null,
      orderRef: order_ref || null,
    });
    if (!redeemed.ok) {
      return res.status(409).json({ successful: false, message: redeemed.message });
    }
    res.json({
      successful: true,
      amount: validated.amount,
      code: validated.code,
      redemption: redeemed.redemption,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ successful: false, message: 'Failed to redeem promo' });
  }
});

export default router;
