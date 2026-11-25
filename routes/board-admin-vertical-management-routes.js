// routes/board-admin-vertical-management-routes.js
//
// Read-only Vertical Management data for the internal dashboards
// (strug-internal-dashboards → Vertical Management dashboard). Gated by the board
// identity + can_manage_members (the admin tier) — mirrors Finance / Operations,
// where cross-vertical marketplace data (with owner emails) is sensitive.
//
// Mounted at /board-admin/vertical-management. ALL endpoints are READ-ONLY.
//
// Where Operations is the marketplace *activity* (orders/trips flowing), Vertical
// Management is the *catalog/supply config behind it*: the listings, storefronts,
// items, categories and per-vertical taxonomy. The platform ships ~5 of 70+
// verticals from the master doc, so a core job is honestly showing which verticals
// have real catalog data vs. which aren't built. Nothing here mutates state —
// enable/disable/clone/approve controls are deliberately NOT built (read-only).
//
//   GET /overview      per-vertical catalog rollup (# listings · active · owners · categories · items)
//   GET /listings      unified cross-vertical listing feed (vertical/subtype/category/active filters)
//   GET /categories    per-vertical category taxonomy + counts
//   GET /performance   per-vertical order rollup (orders · GMV · completion/cancel rates · daily trend)
//
// Catalog tables differ wildly (confirmed by grepping schema.prisma) — owner FK,
// category FK, and the "active" flag are named differently per table, and most
// listing tables have NO created_at. The union normalizes all of that server-side.

import express from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../utils/prisma-client.js';
import { authenticateBoard, requireDashboard } from '../middleware/authenticate-board.js';
import { decrypt } from '../utils/crypto.js';

const router = express.Router();
router.use(authenticateBoard, requireDashboard('vertical-management', 'read'));

const num = (d) => (d == null ? 0 : Number(d));
const clampInt = (v, lo, hi, dflt) => {
  const n = parseInt(v);
  if (Number.isNaN(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};

// user.email is encrypted at rest (deterministic AES); this board endpoint is
// authorized to display it. Only decrypt hex-looking ciphertext.
const looksEncrypted = (v) => typeof v === 'string' && v.length >= 32 && v.length % 2 === 0 && /^[0-9a-f]+$/i.test(v);
const decryptEmail = (v) => {
  if (!looksEncrypted(v)) return v;
  try { return decrypt(v); } catch { return v; }
};

async function userSummaries(ids) {
  const unique = [...new Set(ids.filter((x) => x != null))];
  if (!unique.length) return {};
  const users = await prisma.user.findMany({
    where: { user_id: { in: unique } },
    select: {
      user_id: true, name: true, username: true, email: true,
      social_profiles: { select: { display_name: true, handle: true } },
    },
  });
  const map = {};
  for (const u of users) {
    map[u.user_id] = {
      user_id: u.user_id,
      name: u.name,
      username: u.username,
      email: decryptEmail(u.email),
      display_name: u.social_profiles?.display_name || null,
      handle: u.social_profiles?.handle || null,
    };
  }
  return map;
}

// The catalog verticals — those with a real listing/storefront table. The label is
// the dashboard-facing name; everything else (rideshare/courier/on-demand, the
// social/media replicas, etc.) is on-demand or social and has no catalog to manage.
const CATALOG_VERTICALS = ['food', 'products', 'digital', 'rentals', 'bookings', 'services', 'events', 'meetups', 'realestate'];

// ── The canonical cross-vertical LISTING union ─────────────────────────────────
// Each subquery normalizes one catalog table into a uniform row:
//   vertical · ref_id · title · owner_id · category_id · category_text · sub_type ·
//   active (bool) · created_at (nullable — most listing tables have none).
// `active` is normalized per table's own flag; tables with no disable flag
// (digital/events/meetups) are reported live=true (they have no off switch).
function listingsUnion() {
  return Prisma.sql`
    SELECT 'food'::text AS vertical, fv.vendor_id AS ref_id, fv.vendor_name AS title, fv.owner_id,
           fv.vendor_type_id AS category_id, NULL::text AS category_text, vt.vendor_type AS sub_type,
           fv.is_active AS active, NULL::timestamp AS created_at
      FROM food_vendor fv LEFT JOIN vendor_type vt ON vt.vendor_type_id = fv.vendor_type_id
    UNION ALL
    SELECT 'products', listing_id, name, seller_id, product_type_id, NULL, NULL,
           (COALESCE(availability, 0) > 0), NULL
      FROM product_listing
    UNION ALL
    SELECT 'digital', content_id, content_title, NULL, dg_category_id, NULL, NULL,
           true, date::timestamp
      FROM dg_content
    UNION ALL
    SELECT 'rentals', rental_listing_id, rental_listing_name, owner_id, rental_category_id, NULL, NULL,
           COALESCE(is_available, false), NULL
      FROM rental_listing
    UNION ALL
    SELECT 'bookings', booking_listing_id, title, owner_id, NULL, vertical, vertical,
           is_active, created_at
      FROM booking_listing
    UNION ALL
    SELECT 'services', provider_id, NULL, user_id, service_category_id, NULL, NULL,
           is_active, NULL
      FROM user_service_provider
    UNION ALL
    SELECT 'events', place_id, location_address, user_id, event_type_id, NULL, NULL,
           true, NULL
      FROM place
    UNION ALL
    SELECT 'meetups', meetup_event_id, meetup_event_name, meetup_event_organizer, meetup_event_category_id, NULL, NULL,
           true, meetup_event_start_time::timestamp
      FROM meetup_event
    UNION ALL
    SELECT 'realestate', property_id, property_name, user_id, NULL, type,
           CASE WHEN type IS NULL THEN NULL WHEN lower(type) IN ('vehicle','equipment') THEN type ELSE type END,
           CASE WHEN status IS NULL THEN true WHEN lower(status) IN ('active','available','published','live','listed') THEN true ELSE false END,
           NULL
      FROM property
  `;
}

const VERTICAL_LABEL = {
  food: 'Food & grocery', products: 'Ecommerce', digital: 'Digital goods', rentals: 'Rentals',
  bookings: 'Booking engine', services: 'Services', events: 'Event venues', meetups: 'Meetups',
  realestate: 'Real estate',
};

// ─── OVERVIEW (per-vertical catalog rollup) ─────────────────────────────────────
router.get('/overview', async (req, res) => {
  try {
    const union = listingsUnion();

    const [byVertical, catFood, catProduct, catDigital, catRentalC, catService, catEvent, catVendorType, catWork,
      foodItems, productVariations, bookingVerticals] = await Promise.all([
      // listings / active / distinct owners per vertical
      prisma.$queryRaw`
        SELECT vertical,
               COUNT(*)::int AS listings,
               COUNT(*) FILTER (WHERE active IS TRUE)::int AS active,
               COUNT(*) FILTER (WHERE active IS FALSE)::int AS inactive,
               COUNT(DISTINCT owner_id)::int AS owners
        FROM ( ${union} ) u GROUP BY 1`,
      prisma.food_category.count(),
      prisma.product_type.count(),
      prisma.dg_categories.count(),
      prisma.rental_categories.count(),
      prisma.service_category.count(),
      prisma.event_type.count(),
      prisma.vendor_type.count(),
      prisma.work_category.count(),
      prisma.food_item.count(),
      prisma.product_variation.count(),
      // distinct booking-engine sub-verticals (the booking_listing.vertical values that actually exist)
      prisma.$queryRaw`SELECT vertical, COUNT(*)::int AS count FROM booking_listing GROUP BY 1 ORDER BY 2 DESC`,
    ]);

    // categories per vertical (taxonomy size)
    const CATS = {
      food: catVendorType + catFood, // vendor types + food categories
      products: catProduct,
      digital: catDigital,
      rentals: catRentalC,
      services: catService,
      events: catEvent,
      // bookings/meetups/realestate use free-text verticals/types — no fixed taxonomy table
      bookings: 0, meetups: 0, realestate: 0,
    };
    // catalog item counts (sub-listing depth) per vertical
    const ITEMS = { food: foodItems, products: productVariations };

    const vmap = {};
    for (const v of CATALOG_VERTICALS) {
      vmap[v] = {
        vertical: v, label: VERTICAL_LABEL[v] || v,
        listings: 0, active: 0, inactive: 0, owners: 0,
        categories: CATS[v] || 0, items: ITEMS[v] || 0,
      };
    }
    for (const r of byVertical) {
      const row = vmap[r.vertical]; if (!row) continue;
      row.listings = r.listings; row.active = r.active; row.inactive = r.inactive; row.owners = r.owners;
    }
    const rows = Object.values(vmap);

    const totals = {
      listings: rows.reduce((s, v) => s + v.listings, 0),
      active: rows.reduce((s, v) => s + v.active, 0),
      owners: rows.reduce((s, v) => s + v.owners, 0),
      categories: rows.reduce((s, v) => s + v.categories, 0),
      items: rows.reduce((s, v) => s + v.items, 0),
      catalogVerticals: rows.filter((v) => v.listings > 0).length,
    };

    res.json({
      verticals: rows.sort((a, b) => b.listings - a.listings),
      totals,
      bookingSubVerticals: bookingVerticals, // [{ vertical, count }] — the real booking_listing.vertical values
      workCategories: catWork,
      note: 'Per-vertical catalog supply: listings (storefronts/products/listings), active vs. inactive, distinct owners, taxonomy size, and item depth. Verticals without a catalog table (rideshare/courier/on-demand, social/media) are not listed — their supply is live, not catalog. "Active" reflects each table\'s own enable flag; digital/events/meetups have no off switch so they are reported live.',
    });
  } catch (err) {
    console.error('[board-admin/vertical-management] overview error:', err);
    res.status(500).json({ successful: false, message: 'Could not load vertical overview' });
  }
});

// ─── CATEGORIES (per-vertical taxonomy) ─────────────────────────────────────────
router.get('/categories', async (req, res) => {
  try {
    const [vendorTypes, foodCats, productTypes, dgCats, rentalTypes, rentalCats, serviceTypes, serviceCats, eventTypes, workCats] =
      await Promise.all([
        prisma.vendor_type.findMany({ select: { vendor_type_id: true, vendor_type: true } }),
        prisma.food_category.findMany({ select: { food_category_id: true, name: true, vendor_type_id: true } }),
        prisma.product_type.findMany({ select: { product_type_id: true, product_type_name: true } }),
        prisma.dg_categories.findMany({ select: { dg_category_id: true, dg_category_name: true } }),
        prisma.rental_type.findMany({ select: { rental_type_id: true, rental_type_name: true } }),
        prisma.rental_categories.findMany({ select: { rental_category_id: true, rental_category_name: true, rental_type_id: true } }),
        prisma.service_type.findMany({ select: { service_type_id: true, service_type_name: true } }),
        prisma.service_category.findMany({ select: { service_category_id: true, service_category_name: true, service_type_id: true } }),
        prisma.event_type.findMany({ select: { event_type_id: true, event_type_name: true } }),
        prisma.work_category.findMany({ select: { work_category_id: true, name: true, parent_id: true, is_active: true } }),
      ]);

    const map = (arr, id, name, extra) => arr.map((r) => ({ id: r[id], name: r[name] || `#${r[id]}`, ...(extra ? extra(r) : {}) }));

    res.json({
      verticals: [
        { vertical: 'food', label: 'Food & grocery', groups: [
          { label: 'Vendor types', items: map(vendorTypes, 'vendor_type_id', 'vendor_type') },
          { label: 'Food categories', items: map(foodCats, 'food_category_id', 'name', (r) => ({ parent: r.vendor_type_id })) },
        ]},
        { vertical: 'products', label: 'Ecommerce', groups: [
          { label: 'Product types', items: map(productTypes, 'product_type_id', 'product_type_name') },
        ]},
        { vertical: 'digital', label: 'Digital goods', groups: [
          { label: 'Digital categories', items: map(dgCats, 'dg_category_id', 'dg_category_name') },
        ]},
        { vertical: 'rentals', label: 'Rentals', groups: [
          { label: 'Rental types', items: map(rentalTypes, 'rental_type_id', 'rental_type_name') },
          { label: 'Rental categories', items: map(rentalCats, 'rental_category_id', 'rental_category_name', (r) => ({ parent: r.rental_type_id })) },
        ]},
        { vertical: 'services', label: 'Services', groups: [
          { label: 'Service types', items: map(serviceTypes, 'service_type_id', 'service_type_name') },
          { label: 'Service categories', items: map(serviceCats, 'service_category_id', 'service_category_name', (r) => ({ parent: r.service_type_id })) },
        ]},
        { vertical: 'events', label: 'Event venues', groups: [
          { label: 'Event types', items: map(eventTypes, 'event_type_id', 'event_type_name') },
        ]},
        { vertical: 'work', label: 'On-demand work', groups: [
          { label: 'Work categories', items: map(workCats, 'work_category_id', 'name', (r) => ({ parent: r.parent_id, active: r.is_active })) },
        ]},
      ],
      note: 'Category taxonomy per vertical. Food is two-level (vendor type → food category); rentals & services are type → category. Booking-engine, meetups and real estate use free-text verticals/types with no fixed taxonomy table.',
    });
  } catch (err) {
    console.error('[board-admin/vertical-management] categories error:', err);
    res.status(500).json({ successful: false, message: 'Could not load categories' });
  }
});

// Category-name lookup maps so the listing feed can show a human category per row.
async function categoryMaps() {
  const [vendorTypes, productTypes, dgCats, rentalCats, serviceCats, eventTypes] = await Promise.all([
    prisma.vendor_type.findMany({ select: { vendor_type_id: true, vendor_type: true } }),
    prisma.product_type.findMany({ select: { product_type_id: true, product_type_name: true } }),
    prisma.dg_categories.findMany({ select: { dg_category_id: true, dg_category_name: true } }),
    prisma.rental_categories.findMany({ select: { rental_category_id: true, rental_category_name: true } }),
    prisma.service_category.findMany({ select: { service_category_id: true, service_category_name: true } }),
    prisma.event_type.findMany({ select: { event_type_id: true, event_type_name: true } }),
  ]);
  const m = (arr, id, name) => Object.fromEntries(arr.map((r) => [r[id], r[name]]));
  return {
    food: m(vendorTypes, 'vendor_type_id', 'vendor_type'), // food category_id is vendor_type_id
    products: m(productTypes, 'product_type_id', 'product_type_name'),
    digital: m(dgCats, 'dg_category_id', 'dg_category_name'),
    rentals: m(rentalCats, 'rental_category_id', 'rental_category_name'),
    services: m(serviceCats, 'service_category_id', 'service_category_name'),
    events: m(eventTypes, 'event_type_id', 'event_type_name'),
  };
}

// ─── LISTINGS (unified cross-vertical catalog feed — the workhorse) ─────────────
router.get('/listings', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
    const offset = (page - 1) * limit;

    const vertical = CATALOG_VERTICALS.includes(req.query.vertical) ? req.query.vertical : null;
    const subType = typeof req.query.subType === 'string' && req.query.subType.trim() ? req.query.subType.trim() : null;
    const categoryId = req.query.category != null && !Number.isNaN(parseInt(req.query.category)) ? parseInt(req.query.category) : null;
    const activeParam = req.query.active; // 'true' | 'false'
    const search = typeof req.query.search === 'string' && req.query.search.trim() ? req.query.search.trim() : null;

    const union = listingsUnion();
    const filters = [Prisma.sql`1=1`];
    if (vertical) filters.push(Prisma.sql`vertical = ${vertical}`);
    if (subType) filters.push(Prisma.sql`lower(sub_type) = ${subType.toLowerCase()}`);
    if (categoryId != null) filters.push(Prisma.sql`category_id = ${categoryId}`);
    if (activeParam === 'true') filters.push(Prisma.sql`active IS TRUE`);
    if (activeParam === 'false') filters.push(Prisma.sql`active IS FALSE`);
    if (search) filters.push(Prisma.sql`title ILIKE ${'%' + search + '%'}`);
    const where = Prisma.join(filters, ' AND ');

    const [rows, countRows, byVertical] = await Promise.all([
      prisma.$queryRaw`SELECT * FROM ( ${union} ) f WHERE ${where} ORDER BY created_at DESC NULLS LAST, vertical, ref_id DESC LIMIT ${limit} OFFSET ${offset}`,
      prisma.$queryRaw`SELECT COUNT(*)::int AS total FROM ( ${union} ) f WHERE ${where}`,
      prisma.$queryRaw`SELECT vertical, COUNT(*)::int AS count FROM ( ${union} ) f WHERE ${where} GROUP BY 1 ORDER BY 2 DESC`,
    ]);

    const total = countRows[0]?.total || 0;
    const [users, cats] = await Promise.all([
      userSummaries(rows.map((r) => r.owner_id)),
      categoryMaps(),
    ]);

    const listings = rows.map((r) => {
      const catName = r.category_text || (cats[r.vertical] ? cats[r.vertical][r.category_id] : null) || null;
      return {
        id: `${r.vertical}-${r.ref_id}`,
        ref_id: r.ref_id,
        vertical: r.vertical,
        label: VERTICAL_LABEL[r.vertical] || r.vertical,
        title: r.title,
        owner_id: r.owner_id,
        owner: users[r.owner_id] || null,
        category: catName,
        sub_type: r.sub_type,
        active: r.active,
        created_at: r.created_at,
      };
    });

    res.json({
      listings,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
      byVertical,
      filters: { vertical, subType, category: categoryId, active: activeParam || null, search },
      note: 'Unified catalog feed across every vertical that has a listing table. Owner is resolved to the user account; category is the per-table taxonomy. "active" is each table\'s own enable flag (digital/events/meetups have none → reported live).',
    });
  } catch (err) {
    console.error('[board-admin/vertical-management] listings error:', err);
    res.status(500).json({ successful: false, message: 'Could not load listings' });
  }
});

// ── per-vertical ORDER rollup (catalog → demand). Order tables are Operations'
// turf; here we only roll them up per vertical for the "N listings · M orders ·
// completion rate" performance views. Bucket = completed / cancelled / other.
function ordersRollupUnion(cutoff) {
  return Prisma.sql`
    SELECT 'food'::text AS vertical, total_amount::float AS amount, ispaid AS paid,
           (order_status IN ('delivered','completed','reconciled')) AS completed,
           (order_status = 'cancelled') AS cancelled, created_at
      FROM food_order WHERE created_at >= ${cutoff}
    UNION ALL
    SELECT 'products', total::float, ispaid,
           (status IN ('delivered','completed')), (status = 'cancelled'), order_time
      FROM product_order WHERE order_time >= ${cutoff}
    UNION ALL
    SELECT 'digital', total::float, ispaid, ispaid, false, date::timestamp
      FROM dg_order WHERE date >= ${cutoff}
    UNION ALL
    SELECT 'rentals', total::float, ispaid,
           (status IN ('delivered','completed','returned')), (status = 'cancelled'), date::timestamp
      FROM rental_order WHERE date >= ${cutoff}
    UNION ALL
    SELECT 'services', total::float, ispaid,
           (status = 'completed'), (status = 'cancelled'), created_at
      FROM service_order WHERE created_at >= ${cutoff}
    UNION ALL
    SELECT 'bookings', total::float, (payment_status = 'paid'),
           (status IN ('completed','paid')), (status = 'cancelled'), created_at
      FROM booking WHERE created_at >= ${cutoff}
    UNION ALL
    SELECT 'events', price::float, (status = 'completed'),
           (status = 'completed'), (status = 'cancelled'), reserve_date
      FROM place_orders WHERE reserve_date >= ${cutoff}
  `;
}

// ─── PERFORMANCE (per-vertical order rollup + daily trend) ──────────────────────
router.get('/performance', async (req, res) => {
  try {
    const days = clampInt(req.query.days, 1, 365, 30);
    const cutoff = new Date(Date.now() - days * 86400000);
    const union = ordersRollupUnion(cutoff);

    const [byVertical, daily] = await Promise.all([
      prisma.$queryRaw`
        SELECT vertical,
               COUNT(*)::int AS orders,
               SUM(amount)::float AS gmv,
               SUM(CASE WHEN paid THEN amount ELSE 0 END)::float AS paid_gmv,
               COUNT(*) FILTER (WHERE completed)::int AS completed,
               COUNT(*) FILTER (WHERE cancelled)::int AS cancelled,
               COUNT(*) FILTER (WHERE paid)::int AS paid_orders
        FROM ( ${union} ) u GROUP BY 1`,
      prisma.$queryRaw`
        SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS date,
               COUNT(*)::int AS orders, SUM(amount)::float AS gmv
        FROM ( ${union} ) u WHERE created_at IS NOT NULL GROUP BY 1 ORDER BY 1`,
    ]);

    const rows = byVertical.map((r) => ({
      vertical: r.vertical,
      label: VERTICAL_LABEL[r.vertical] || r.vertical,
      orders: r.orders,
      gmv: num(r.gmv),
      paidGmv: num(r.paid_gmv),
      completed: r.completed,
      cancelled: r.cancelled,
      paidOrders: r.paid_orders,
      completionRate: r.orders ? (r.completed / r.orders) * 100 : 0,
      cancellationRate: r.orders ? (r.cancelled / r.orders) * 100 : 0,
    })).sort((a, b) => b.gmv - a.gmv);

    const totals = {
      orders: rows.reduce((s, v) => s + v.orders, 0),
      gmv: rows.reduce((s, v) => s + v.gmv, 0),
      paidGmv: rows.reduce((s, v) => s + v.paidGmv, 0),
      completed: rows.reduce((s, v) => s + v.completed, 0),
      cancelled: rows.reduce((s, v) => s + v.cancelled, 0),
    };

    res.json({
      days,
      verticals: rows,
      totals,
      daily, // [{ date, orders, gmv }]
      note: 'Per-vertical demand rollup: order volume, GMV (gross order value, not net revenue), and completion / cancellation rates over the window. Order data is owned by the Operations & Finance dashboards — surfaced here only to relate catalog supply to demand.',
    });
  } catch (err) {
    console.error('[board-admin/vertical-management] performance error:', err);
    res.status(500).json({ successful: false, message: 'Could not load vertical performance' });
  }
});

// ─── GROWTH (new users / sellers by vertical, from vertical_profile) ────────────
// vertical_profile is the per-vertical identity a user creates when they engage a
// vertical (seller/creator side). Counting it per vertical = adoption per vertical.
router.get('/growth', async (req, res) => {
  try {
    const days = clampInt(req.query.days, 1, 365, 90);
    const cutoff = new Date(Date.now() - days * 86400000);

    const [byVertical, customized, recent, daily] = await Promise.all([
      prisma.vertical_profile.groupBy({ by: ['vertical'], _count: { _all: true } }),
      prisma.vertical_profile.groupBy({ by: ['vertical'], where: { is_customized: true }, _count: { _all: true } }),
      prisma.vertical_profile.groupBy({ by: ['vertical'], where: { created_at: { gte: cutoff } }, _count: { _all: true } }),
      prisma.$queryRaw`
        SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS date, COUNT(*)::int AS profiles
        FROM vertical_profile WHERE created_at >= ${cutoff} GROUP BY 1 ORDER BY 1`,
    ]);

    const cmap = Object.fromEntries(customized.map((r) => [r.vertical, r._count._all]));
    const rmap = Object.fromEntries(recent.map((r) => [r.vertical, r._count._all]));
    const rows = byVertical.map((r) => ({
      vertical: r.vertical,
      profiles: r._count._all,
      customized: cmap[r.vertical] || 0,
      recent: rmap[r.vertical] || 0,
    })).sort((a, b) => b.profiles - a.profiles);

    res.json({
      days,
      verticals: rows,
      totals: {
        profiles: rows.reduce((s, v) => s + v.profiles, 0),
        customized: rows.reduce((s, v) => s + v.customized, 0),
        recent: rows.reduce((s, v) => s + v.recent, 0),
      },
      daily,
      note: 'Per-vertical adoption from vertical_profile — the per-vertical identity a user creates when they engage a vertical (seller/creator side). "customized" = profiles the owner has personalized; "recent" = created in the window.',
    });
  } catch (err) {
    console.error('[board-admin/vertical-management] growth error:', err);
    res.status(500).json({ successful: false, message: 'Could not load vertical growth' });
  }
});

// ─── PRICING (discounts + per-vertical fee structures) ──────────────────────────
router.get('/pricing', async (req, res) => {
  try {
    const days = clampInt(req.query.days, 1, 365, 30);
    const cutoff = new Date(Date.now() - days * 86400000);

    const [discCount, discAgg, discounted, foodFees, productFees, bookingFees, rideFees] = await Promise.all([
      prisma.product_variation.count({ where: { discount_pct: { gt: 0 } } }),
      prisma.product_variation.aggregate({ _avg: { discount_pct: true }, _max: { discount_pct: true }, where: { discount_pct: { gt: 0 } } }),
      prisma.product_variation.findMany({
        where: { discount_pct: { gt: 0 } }, orderBy: { discount_pct: 'desc' }, take: 40,
        select: { variation_id: true, vname: true, price: true, discount_pct: true, product_listing: { select: { name: true } } },
      }),
      prisma.food_order.aggregate({ _sum: { delivery_fee: true, platform_fee: true }, _count: true, where: { ispaid: true, created_at: { gte: cutoff } } }),
      prisma.product_order.aggregate({ _sum: { delivery_fee: true, platform_fee: true }, _count: true, where: { ispaid: true, order_time: { gte: cutoff } } }),
      prisma.booking.aggregate({ _sum: { service_fee: true }, _count: true, where: { payment_status: 'paid', created_at: { gte: cutoff } } }),
      prisma.active_trip.aggregate({ _sum: { platform_fee: true }, _count: true, where: { ended_at: { not: null, gte: cutoff } } }),
    ]);

    // Per-vertical fee model reference (which fee columns each vertical actually charges).
    const feeModel = [
      { vertical: 'food', label: 'Food & grocery', fees: ['delivery_fee', 'platform_fee'], recorded: num(foodFees._sum.delivery_fee) + num(foodFees._sum.platform_fee), orders: foodFees._count, pricing: 'vendor-set item prices' },
      { vertical: 'products', label: 'Ecommerce', fees: ['delivery_fee', 'platform_fee', 'discount_pct'], recorded: num(productFees._sum.delivery_fee) + num(productFees._sum.platform_fee), orders: productFees._count, pricing: 'seller-set + per-variation discounts' },
      { vertical: 'bookings', label: 'Booking engine', fees: ['service_fee_pct', 'cleaning_fee', 'service_fee'], recorded: num(bookingFees._sum.service_fee), orders: bookingFees._count, pricing: 'owner-set nightly/unit price' },
      { vertical: 'rideshare', label: 'Rideshare', fees: ['platform_fee'], recorded: num(rideFees._sum.platform_fee), orders: rideFees._count, pricing: 'distance/time metered fare' },
      { vertical: 'rentals', label: 'Rentals', fees: [], recorded: 0, orders: 0, pricing: 'owner-set rental amount' },
      { vertical: 'digital', label: 'Digital goods', fees: [], recorded: 0, orders: 0, pricing: 'author-set price' },
      { vertical: 'services', label: 'Services', fees: [], recorded: 0, orders: 0, pricing: 'provider-set service price' },
    ];

    res.json({
      days,
      discounts: {
        count: discCount,
        avgPct: discAgg._avg.discount_pct ? Number(discAgg._avg.discount_pct.toFixed(1)) : 0,
        maxPct: discAgg._max.discount_pct || 0,
        items: discounted.map((d) => ({ id: d.variation_id, listing: d.product_listing?.name || `Variation ${d.variation_id}`, variant: d.vname, price: num(d.price), discount_pct: d.discount_pct })),
      },
      feeModel,
      note: 'Pricing config that the platform actually records. Discounts = product_variation.discount_pct (the only stored discount mechanism). Fee model = which fee columns each vertical charges + the fees recorded over the window. Most prices are user-set; commission/tax/surge rules are not stored in a config table.',
    });
  } catch (err) {
    console.error('[board-admin/vertical-management] pricing error:', err);
    res.status(500).json({ successful: false, message: 'Could not load pricing config' });
  }
});

// Group a list of user country/city strings into sorted {label,count} buckets.
function geoBuckets(users, field) {
  const m = {};
  for (const u of users) {
    const raw = (u[field] || '').trim();
    if (!raw) continue;
    const key = raw.length > 60 ? raw.slice(0, 60) : raw;
    m[key] = (m[key] || 0) + 1;
  }
  return Object.entries(m).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
}

// ─── REGIONAL (catalog + supply geography, from owner/provider user country/city) ─
router.get('/regional', async (req, res) => {
  try {
    const union = listingsUnion();
    // distinct listing owners
    const ownerRows = await prisma.$queryRaw`SELECT DISTINCT owner_id FROM ( ${union} ) u WHERE owner_id IS NOT NULL`;
    const ownerIds = ownerRows.map((r) => r.owner_id);

    // provider + merchant user ids across the supply tables
    const [drivers, workers, svcProviders, vendors, couriers, appts] = await Promise.all([
      prisma.driver_profile.findMany({ select: { user_id: true } }),
      prisma.worker_profile.findMany({ select: { user_id: true } }),
      prisma.user_service_provider.findMany({ select: { user_id: true } }),
      prisma.food_vendor.findMany({ select: { owner_id: true } }),
      prisma.driver_profile.findMany({ where: { driver_courier_profile: { isNot: null } }, select: { user_id: true } }),
      prisma.appointment_service_providers.findMany({ select: { service_provider_user_id: true } }),
    ]);
    const providerIds = [...new Set([
      ...drivers.map((d) => d.user_id), ...workers.map((w) => w.user_id), ...svcProviders.map((s) => s.user_id),
      ...vendors.map((v) => v.owner_id), ...couriers.map((c) => c.user_id), ...appts.map((a) => a.service_provider_user_id),
    ].filter((x) => x != null))];
    const merchantIds = [...new Set(vendors.map((v) => v.owner_id).filter((x) => x != null))];

    const allIds = [...new Set([...ownerIds, ...providerIds, ...merchantIds])];
    const users = allIds.length
      ? await prisma.user.findMany({ where: { user_id: { in: allIds } }, select: { user_id: true, country: true, city: true } })
      : [];
    const umap = Object.fromEntries(users.map((u) => [u.user_id, u]));
    const pick = (ids) => ids.map((id) => umap[id]).filter(Boolean);

    const owners = pick(ownerIds);
    res.json({
      ownerCountries: geoBuckets(owners, 'country'),
      ownerCities: geoBuckets(owners, 'city'),
      providerCountries: geoBuckets(pick(providerIds), 'country'),
      merchantCountries: geoBuckets(pick(merchantIds), 'country'),
      counts: { owners: ownerIds.length, providers: providerIds.length, merchants: merchantIds.length, geoKnownOwners: owners.filter((u) => u.country).length },
      note: 'Regional view of catalog supply by the country/city on each owner / provider / merchant user account. Addresses are free-text (city + country only, no province/zone), so this is account-level geography, not a structured coverage map.',
    });
  } catch (err) {
    console.error('[board-admin/vertical-management] regional error:', err);
    res.status(500).json({ successful: false, message: 'Could not load regional data' });
  }
});

// ─── QUALITY (provider performance ratings + business/merchant performance) ──────
router.get('/quality', async (req, res) => {
  try {
    const [driverAgg, workerAgg, quoteAgg, svcRateAgg, apptAgg, topVendors, topSellers] = await Promise.all([
      prisma.driver_profile.aggregate({ _avg: { rating: true }, _count: { rating: true } }),
      prisma.worker_profile.aggregate({ _avg: { rating: true }, _count: { rating: true } }),
      prisma.quote_provider.aggregate({ _avg: { rating: true }, _count: { rating: true } }),
      prisma.service_ratings.aggregate({ _avg: { rating: true }, _count: { rating: true } }),
      prisma.appointment_rating.aggregate({ _avg: { rating: true }, _count: { rating: true } }),
      // top food merchants by paid order volume
      prisma.food_order.groupBy({ by: ['vendor_id'], where: { ispaid: true }, _count: { _all: true }, _sum: { total_amount: true }, orderBy: { _count: { vendor_id: 'desc' } }, take: 15 }),
      // top product sellers by paid order volume
      prisma.product_order.groupBy({ by: ['seller_id'], where: { ispaid: true }, _count: { _all: true }, _sum: { total: true }, orderBy: { _count: { seller_id: 'desc' } }, take: 15 }),
    ]);

    const round = (n) => (n == null ? null : Number(Number(n).toFixed(2)));
    const performance = [
      { domain: 'driver', label: 'Rideshare drivers', rated: driverAgg._count.rating, avgRating: round(driverAgg._avg.rating) },
      { domain: 'worker', label: 'On-demand workers', rated: workerAgg._count.rating, avgRating: round(workerAgg._avg.rating) },
      { domain: 'service', label: 'Service providers', rated: svcRateAgg._count.rating, avgRating: round(svcRateAgg._avg.rating) },
      { domain: 'quote', label: 'Quote providers', rated: quoteAgg._count.rating, avgRating: round(quoteAgg._avg.rating) },
      { domain: 'appointment', label: 'Appointment providers', rated: apptAgg._count.rating, avgRating: round(apptAgg._avg.rating) },
    ];

    // resolve vendor + seller names/owners
    const vendorIds = topVendors.map((v) => v.vendor_id).filter((x) => x != null);
    const vendors = vendorIds.length ? await prisma.food_vendor.findMany({ where: { vendor_id: { in: vendorIds } }, select: { vendor_id: true, vendor_name: true } }) : [];
    const vmap = Object.fromEntries(vendors.map((v) => [v.vendor_id, v.vendor_name]));
    const sellers = await userSummaries(topSellers.map((s) => s.seller_id));

    res.json({
      performance,
      topMerchants: {
        food: topVendors.map((v) => ({ id: v.vendor_id, name: vmap[v.vendor_id] || `Vendor ${v.vendor_id}`, orders: v._count._all, gmv: num(v._sum.total_amount) })),
        products: topSellers.map((s) => ({ id: s.seller_id, name: sellers[s.seller_id] ? (sellers[s.seller_id].display_name || sellers[s.seller_id].username || `Seller ${s.seller_id}`) : `Seller ${s.seller_id}`, orders: s._count._all, gmv: num(s._sum.total) })),
      },
      note: 'Provider performance = average rating + rated count per supply domain (ratings are sparse on a young marketplace). Business performance = top merchants/sellers by paid order volume (food_order.vendor_id, product_order.seller_id).',
    });
  } catch (err) {
    console.error('[board-admin/vertical-management] quality error:', err);
    res.status(500).json({ successful: false, message: 'Could not load quality data' });
  }
});

export default router;
