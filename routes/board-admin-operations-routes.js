// routes/board-admin-operations-routes.js
//
// Read-only Operations data for the internal dashboards (strug-internal-dashboards
// → Operations dashboard). Gated by the board identity + can_manage_members (the
// admin tier) — mirrors Finance, where marketplace order/provider data is sensitive.
//
// Mounted at /board-admin/operations. ALL endpoints are READ-ONLY. Operations is
// the marketplace *activity* itself (orders, trips, deliveries, bookings, jobs,
// providers), unioned across the fragmented per-vertical tables. Nothing here
// mutates state — reassign/cancel/override controls are deliberately NOT built.
//
//   GET /overview     cross-vertical live KPIs + per-vertical activity + daily trend
//   GET /orders       unified cross-vertical order feed (vertical/bucket/days filters)
//   GET /rideshare    ride_request status breakdown + active trips + driver supply
//   GET /courier      courier_order status breakdown + courier supply + recent
//   GET /bookings     booking status/payment breakdown + upcoming + recent
//   GET /providers    provider directory + supply health across the *_provider tables
//
// Status conventions differ per table (confirmed by grepping the writing routes):
//   food_order.order_status : pending|confirmed|preparing|ready_for_pickup|picked_up|delivered|cancelled (+active|reconciled)
//   product_order.status    : pending|confirmed|processing|... (+delivered|cancelled)
//   courier_order.status    : pending|accepted|picked_up|delivered
//   ride_request.status     : pending|pending_payment|accepted|completed|cancelled|frozen|succeeded
//   booking.status          : requested|pending|confirmed|processing|paid|cancelled  (+ payment_status)
//   service_order.status    : pending|accepted|in_progress|completed|cancelled
//   work_job.status         : draft|searching|accepted|worker_en_route|in_progress|completed|cancelled
//   place_orders.status     : pending|... ;  donations.payment_status : unpaid|paid
// Normalized into 4 buckets server-side: new · active · completed · cancelled
// (+ a `scheduled` override when a future scheduled date exists).

import express from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../utils/prisma-client.js';
import { authenticateBoard, requireDashboard } from '../middleware/authenticate-board.js';
import { decrypt } from '../utils/crypto.js';

const router = express.Router();
router.use(authenticateBoard, requireDashboard('operations', 'read'));

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

// The canonical cross-vertical order union. Each subquery normalizes one per-vertical
// table into a uniform row: vertical, ref_id, user_id, amount, status (raw text),
// paid, created_at, sched_at (future scheduled date, nullable). Buckets are computed
// in the OUTER query from `status` + (sched_at in the future) so the rule lives in one
// place. Courier joins courier_customer to resolve the underlying user.
//
// `cutoff` bounds the window. We always pass a cutoff so the union stays bounded.
// `sub_type` is a within-vertical split for verticals that have one (food →
// vendor_type name e.g. Grocery/Floral; bookings → booking_listing.vertical e.g.
// tempstay/hotel; rentals → rental_type name e.g. Equipment/Vehicle/Venue). NULL for
// verticals with no sub-type. Surfaced so per-sub-type ops queues can filter on it.
function ordersUnion(cutoff) {
  return Prisma.sql`
    SELECT 'food'::text AS vertical, fo.food_order_id AS ref_id, fo.user_id, fo.total_amount::float AS amount,
           COALESCE(fo.order_status,'pending') AS status, fo.ispaid AS paid, fo.created_at, fo.scheduled_time AS sched_at,
           vt.vendor_type AS sub_type
      FROM food_order fo LEFT JOIN vendor_type vt ON vt.vendor_type_id = fo.vendor_type_id WHERE fo.created_at >= ${cutoff}
    UNION ALL
    SELECT 'products', order_id, buyer_id, total::float, COALESCE(status,'pending'), ispaid, order_time, NULL, NULL
      FROM product_order WHERE order_time >= ${cutoff}
    UNION ALL
    SELECT 'digital', order_id, buyer_id, total::float, CASE WHEN ispaid THEN 'completed' ELSE 'pending' END, ispaid, date::timestamp, NULL, NULL
      FROM dg_order WHERE date >= ${cutoff}
    UNION ALL
    SELECT 'rentals', ro.order_id, ro.buyer_id, ro.total::float, COALESCE(ro.status,'pending'), ro.ispaid, ro.date::timestamp, NULL,
           rt.rental_type_name AS sub_type
      FROM rental_order ro LEFT JOIN rental_type rt ON rt.rental_type_id = ro.rental_type_id WHERE ro.date >= ${cutoff}
    UNION ALL
    SELECT 'services', order_id, buyer_id, total::float, COALESCE(status,'pending'), ispaid, created_at, date::timestamp, NULL
      FROM service_order WHERE created_at >= ${cutoff}
    UNION ALL
    SELECT 'courier', co.courier_order_id, cc.user_id, co.price::float, COALESCE(co.status,'pending'), co.is_paid, co.pickup_date, NULL, NULL
      FROM courier_order co LEFT JOIN courier_customer cc ON cc.customer_id = co.customer_id WHERE co.pickup_date >= ${cutoff}
    UNION ALL
    SELECT 'bookings', b.booking_id, b.guest_id, b.total::float, COALESCE(b.status,'requested'), (b.payment_status = 'paid'), b.created_at, b.start_date::timestamp,
           bl.vertical AS sub_type
      FROM booking b LEFT JOIN booking_listing bl ON bl.booking_listing_id = b.booking_listing_id WHERE b.created_at >= ${cutoff}
    UNION ALL
    SELECT 'rideshare', ride_request_id, passenger_id, COALESCE(estimated_fare, offered_fare, 0)::float, COALESCE(status,'pending'),
           (status IN ('completed','succeeded')), created_at, NULL, NULL
      FROM ride_request WHERE created_at >= ${cutoff}
    UNION ALL
    SELECT 'work', work_job_id, hirer_id, COALESCE(hirer_set_price, hourly_rate, 0)::float, COALESCE(status,'draft'),
           (status = 'completed'), created_at, scheduled_start, NULL
      FROM work_job WHERE created_at >= ${cutoff}
    UNION ALL
    SELECT 'events', place_order_id, user_id, price::float, COALESCE(status,'pending'), (status = 'completed'), reserve_date, reserve_date, NULL
      FROM place_orders WHERE reserve_date >= ${cutoff}
    UNION ALL
    SELECT 'donations', donation_id, donated_user_id, amount::float, COALESCE(payment_status,'unpaid'), (payment_status = 'paid'), donated_date, NULL, NULL
      FROM donations WHERE donated_date >= ${cutoff}
  `;
}

// Wraps the union with the computed bucket. `now` is bound so `scheduled` is stable.
function ordersBucketed(cutoff, now) {
  return Prisma.sql`
    SELECT *, CASE
      WHEN status IN ('cancelled','frozen','rejected','failed','declined') THEN 'cancelled'
      WHEN status IN ('delivered','completed','succeeded','reconciled') THEN 'completed'
      WHEN sched_at IS NOT NULL AND sched_at > ${now} AND status NOT IN ('cancelled','frozen','rejected','failed','declined','delivered','completed','succeeded','reconciled') THEN 'scheduled'
      WHEN status IN ('pending','requested','draft','searching','pending_payment','unpaid') THEN 'new'
      ELSE 'active'
    END AS bucket
    FROM ( ${ordersUnion(cutoff)} ) u
  `;
}

const VERTICALS = ['food', 'products', 'digital', 'rentals', 'services', 'courier', 'bookings', 'rideshare', 'work', 'events', 'donations'];
const BUCKETS = ['new', 'active', 'scheduled', 'completed', 'cancelled'];

// ─── OVERVIEW (live marketplace KPIs + per-vertical activity + daily trend) ──────
router.get('/overview', async (req, res) => {
  try {
    const days = clampInt(req.query.days, 1, 90, 30);
    const now = new Date();
    const cutoff = new Date(now.getTime() - days * 86400000);
    const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);

    const bucketed = ordersBucketed(cutoff, now);

    const [byVertical, totals, todayRows, daily, liveTrips, activeDrivers, onlineProviders, openVendors] = await Promise.all([
      // per-vertical × bucket counts + value over the window
      prisma.$queryRaw`SELECT vertical, bucket, COUNT(*)::int AS count, SUM(amount)::float AS value FROM ( ${bucketed} ) b GROUP BY 1, 2`,
      // window totals by bucket
      prisma.$queryRaw`SELECT bucket, COUNT(*)::int AS count FROM ( ${bucketed} ) b GROUP BY 1`,
      // today's counts by bucket
      prisma.$queryRaw`SELECT bucket, COUNT(*)::int AS count FROM ( ${bucketed} ) b WHERE created_at >= ${todayStart} GROUP BY 1`,
      // daily order volume across all verticals
      prisma.$queryRaw`
        SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS date, COUNT(*)::int AS orders, SUM(amount)::float AS value
        FROM ( ${ordersUnion(cutoff)} ) u WHERE created_at IS NOT NULL GROUP BY 1 ORDER BY 1`,
      prisma.active_trip.count({ where: { ended_at: null } }),
      prisma.driver_profile.count({ where: { is_online: true } }),
      prisma.user_service_provider.count({ where: { is_online: true } }),
      prisma.food_vendor.count({ where: { is_open: true } }),
    ]);

    // shape per-vertical: { vertical, new, active, scheduled, completed, cancelled, total, value }
    const vmap = {};
    for (const v of VERTICALS) vmap[v] = { vertical: v, new: 0, active: 0, scheduled: 0, completed: 0, cancelled: 0, total: 0, value: 0 };
    for (const r of byVertical) {
      const row = vmap[r.vertical]; if (!row) continue;
      row[r.bucket] = r.count; row.total += r.count; row.value += num(r.value);
    }
    const bucketTotals = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
    for (const r of totals) bucketTotals[r.bucket] = r.count;
    const todayTotals = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
    for (const r of todayRows) todayTotals[r.bucket] = r.count;

    res.json({
      days,
      kpis: {
        ordersToday: BUCKETS.reduce((s, b) => s + todayTotals[b], 0),
        activeOrders: bucketTotals.active + bucketTotals.scheduled,
        completedToday: todayTotals.completed,
        cancelledToday: todayTotals.cancelled,
        newToday: todayTotals.new,
        liveTrips,
        activeDrivers,
        onlineProviders,
        openVendors,
        windowOrders: BUCKETS.reduce((s, b) => s + bucketTotals[b], 0),
      },
      byVertical: Object.values(vmap).sort((a, b) => b.total - a.total),
      bucketTotals,
      todayTotals,
      daily, // [{ date, orders, value }]
      note: 'Live marketplace activity unioned across every per-vertical order table. Buckets: new·active·scheduled·completed·cancelled. Value is GMV (gross order/transaction value), not net platform revenue.',
    });
  } catch (err) {
    console.error('[board-admin/operations] overview error:', err);
    res.status(500).json({ successful: false, message: 'Could not load operations overview' });
  }
});

// ─── ORDERS (unified cross-vertical feed) ───────────────────────────────────────
router.get('/orders', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
    const offset = (page - 1) * limit;
    const days = clampInt(req.query.days, 1, 365, 30);
    const now = new Date();
    const cutoff = new Date(now.getTime() - days * 86400000);

    const vertical = VERTICALS.includes(req.query.vertical) ? req.query.vertical : null;
    const bucket = BUCKETS.includes(req.query.bucket) ? req.query.bucket : null;
    const unpaid = req.query.unpaid === 'true';
    // "stuck" = still active but older than 2 days (a blocked/abandoned order).
    const stuck = req.query.stuck === 'true';
    const stuckCutoff = new Date(now.getTime() - 2 * 86400000);
    // within-vertical sub-type (food vendor_type / booking sub-vertical / rental type),
    // matched case-insensitively so e.g. "grocery" finds the "Grocery" vendor_type.
    const subType = typeof req.query.subType === 'string' && req.query.subType.trim() ? req.query.subType.trim() : null;

    const bucketed = ordersBucketed(cutoff, now);
    const filters = [Prisma.sql`1=1`];
    if (vertical) filters.push(Prisma.sql`vertical = ${vertical}`);
    if (bucket) filters.push(Prisma.sql`bucket = ${bucket}`);
    if (subType) filters.push(Prisma.sql`sub_type ILIKE ${'%' + subType + '%'}`);
    if (unpaid) filters.push(Prisma.sql`paid = false AND bucket NOT IN ('completed','cancelled')`);
    if (stuck) filters.push(Prisma.sql`bucket = 'active' AND created_at < ${stuckCutoff}`);
    const where = Prisma.join(filters, ' AND ');

    const [rows, countRows, byVertical, bySubType] = await Promise.all([
      prisma.$queryRaw`SELECT * FROM ( ${bucketed} ) f WHERE ${where} ORDER BY created_at DESC NULLS LAST LIMIT ${limit} OFFSET ${offset}`,
      prisma.$queryRaw`SELECT COUNT(*)::int AS total FROM ( ${bucketed} ) f WHERE ${where}`,
      prisma.$queryRaw`SELECT vertical, COUNT(*)::int AS count FROM ( ${bucketed} ) f WHERE ${where} GROUP BY 1 ORDER BY 2 DESC`,
      // sub-type breakdown, only meaningful when a sub-typed vertical is selected
      vertical
        ? prisma.$queryRaw`SELECT sub_type, COUNT(*)::int AS count FROM ( ${bucketed} ) f WHERE ${where} AND sub_type IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`
        : Promise.resolve([]),
    ]);

    const total = countRows[0]?.total || 0;
    const users = await userSummaries(rows.map((r) => r.user_id));
    const orders = rows.map((r) => ({
      id: `${r.vertical}-${r.ref_id}`,
      ref_id: r.ref_id,
      vertical: r.vertical,
      sub_type: r.sub_type || null,
      user_id: r.user_id,
      user: users[r.user_id] || null,
      amount: num(r.amount),
      status: r.status,
      bucket: r.bucket,
      paid: r.paid,
      created_at: r.created_at,
      scheduled_at: r.sched_at,
    }));

    res.json({
      orders,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
      byVertical, // [{ vertical, count }] for the current filter
      bySubType,  // [{ sub_type, count }] when a sub-typed vertical is selected
      filters: { vertical, bucket, subType, days, unpaid, stuck },
      note: 'Unified order feed across all marketplace verticals. Status is the raw per-table value; bucket is the normalized lifecycle stage. sub_type splits food (vendor type), bookings (sub-vertical) and rentals (rental type).',
    });
  } catch (err) {
    console.error('[board-admin/operations] orders error:', err);
    res.status(500).json({ successful: false, message: 'Could not load orders' });
  }
});

// ─── RIDESHARE (ride_request lifecycle + active trips + driver supply) ───────────
router.get('/rideshare', async (req, res) => {
  try {
    const days = clampInt(req.query.days, 1, 365, 30);
    const cutoff = new Date(Date.now() - days * 86400000);

    // driver_profile is now shared with delivery/courier capabilities, so "rideshare supply"
    // needs a rideshare-specific signal (vehicle/license/trip history), not mere row existence.
    const rideshareDriverWhere = { OR: [
      { vehicle: { some: {} } },
      { license_number: { not: null } },
      { active_trip: { some: {} } },
    ] };
    const [byStatus, activeTrips, totalDrivers, onlineDrivers, recent, payoutAgg] = await Promise.all([
      prisma.ride_request.groupBy({ by: ['status'], _count: { _all: true }, where: { created_at: { gte: cutoff } } }),
      prisma.active_trip.findMany({ where: { ended_at: null }, take: 50, orderBy: { trip_id: 'desc' } }),
      prisma.driver_profile.count({ where: rideshareDriverWhere }),
      prisma.driver_profile.count({ where: { ...rideshareDriverWhere, is_online: true } }),
      prisma.ride_request.findMany({ where: { created_at: { gte: cutoff } }, orderBy: { ride_request_id: 'desc' }, take: 40 }),
      prisma.active_trip.aggregate({ _sum: { driver_payout: true, total_fare: true }, _count: true, where: { ended_at: { not: null, gte: cutoff } } }),
    ]);

    const users = await userSummaries([...recent.map((r) => r.passenger_id), ...activeTrips.map((t) => t.driver_id)]);
    res.json({
      days,
      byStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all })),
      supply: { totalDrivers, onlineDrivers, offlineDrivers: totalDrivers - onlineDrivers, liveTrips: activeTrips.length },
      completed: { count: payoutAgg._count, fares: num(payoutAgg._sum.total_fare), payouts: num(payoutAgg._sum.driver_payout) },
      recent: recent.map((r) => ({
        ride_request_id: r.ride_request_id,
        passenger: users[r.passenger_id] || null,
        status: r.status,
        fare: num(r.estimated_fare ?? r.offered_fare),
        created_at: r.created_at,
      })),
      note: 'Ride requests by lifecycle status; active trips are in-flight (ended_at IS NULL). Driver supply from driver_profile.is_online.',
    });
  } catch (err) {
    console.error('[board-admin/operations] rideshare error:', err);
    res.status(500).json({ successful: false, message: 'Could not load rideshare operations' });
  }
});

// ─── COURIER (courier_order lifecycle + courier supply + recent) ────────────────
router.get('/courier', async (req, res) => {
  try {
    const days = clampInt(req.query.days, 1, 365, 30);
    const cutoff = new Date(Date.now() - days * 86400000);

    const [byStatus, providers, recent, paidAgg] = await Promise.all([
      prisma.courier_order.groupBy({ by: ['status'], _count: { _all: true }, where: { pickup_date: { gte: cutoff } } }),
      prisma.driver_profile.count({ where: { driver_courier_profile: { isNot: null } } }),
      prisma.courier_order.findMany({
        where: { pickup_date: { gte: cutoff } }, orderBy: { courier_order_id: 'desc' }, take: 40,
        include: { courier_customer: { select: { user_id: true } } },
      }),
      prisma.courier_order.aggregate({ _sum: { price: true }, _count: true, where: { is_paid: true, payment_time: { gte: cutoff } } }),
    ]);

    const users = await userSummaries(recent.map((r) => r.courier_customer?.user_id));
    res.json({
      days,
      byStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all })),
      supply: { providers },
      paid: { count: paidAgg._count, value: num(paidAgg._sum.price) },
      recent: recent.map((r) => ({
        courier_order_id: r.courier_order_id,
        customer: users[r.courier_customer?.user_id] || null,
        status: r.status,
        price: num(r.price),
        is_paid: r.is_paid,
        created_at: r.pickup_date,
      })),
      note: 'Courier package jobs by lifecycle status (pending → accepted → picked_up → delivered). Supply = driver_profile rows with a driver_courier_profile capability.',
    });
  } catch (err) {
    console.error('[board-admin/operations] courier error:', err);
    res.status(500).json({ successful: false, message: 'Could not load courier operations' });
  }
});

// ─── BOOKINGS (booking lifecycle + payment + upcoming/recent) ───────────────────
router.get('/bookings', async (req, res) => {
  try {
    const days = clampInt(req.query.days, 1, 365, 30);
    const now = new Date();
    const cutoff = new Date(now.getTime() - days * 86400000);

    const [byStatus, byPayment, upcoming, recent, valueAgg] = await Promise.all([
      prisma.booking.groupBy({ by: ['status'], _count: { _all: true }, where: { created_at: { gte: cutoff } } }),
      prisma.booking.groupBy({ by: ['payment_status'], _count: { _all: true }, where: { created_at: { gte: cutoff } } }),
      prisma.booking.findMany({ where: { start_date: { gte: now } }, orderBy: { start_date: 'asc' }, take: 40 }),
      prisma.booking.findMany({ where: { created_at: { gte: cutoff } }, orderBy: { booking_id: 'desc' }, take: 40 }),
      prisma.booking.aggregate({ _sum: { total: true, service_fee: true }, _count: true, where: { payment_status: 'paid', created_at: { gte: cutoff } } }),
    ]);

    const users = await userSummaries([...upcoming.map((b) => b.guest_id), ...recent.map((b) => b.guest_id)]);
    const mapBooking = (b) => ({
      booking_id: b.booking_id,
      guest: users[b.guest_id] || null,
      status: b.status,
      payment_status: b.payment_status,
      total: num(b.total),
      start_date: b.start_date,
      end_date: b.end_date,
      created_at: b.created_at,
    });
    res.json({
      days,
      byStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all })),
      byPayment: byPayment.map((s) => ({ status: s.payment_status, count: s._count._all })),
      paid: { count: valueAgg._count, value: num(valueAgg._sum.total), fees: num(valueAgg._sum.service_fee) },
      upcoming: upcoming.map(mapBooking),
      recent: recent.map(mapBooking),
      note: 'Booking-engine reservations by lifecycle status and payment status. Upcoming = start_date in the future.',
    });
  } catch (err) {
    console.error('[board-admin/operations] bookings error:', err);
    res.status(500).json({ successful: false, message: 'Could not load bookings operations' });
  }
});

// ─── PROVIDERS (supply directory + health across the *_provider tables) ─────────
// Each provider "domain" maps to one table with its own online/active flag. The
// directory is paginated within a single domain; the summary spans all domains.
// driver/courier/food_delivery all read the shared driver_profile table now — extraWhere
// scopes each domain to its capability (driver_profile carries no capability enum; the
// extension row's presence is the marker). courier's online flag stays a flat driver_profile
// field (couriers have always shared it); food_delivery's online flag lives on the nested
// driver_delivery_profile extension instead, so it's supply-count only here rather than
// stretching this generic directory to understand nested online flags for one domain.
const rideshareDriverWhere = { OR: [
  { vehicle: { some: {} } },
  { license_number: { not: null } },
  { active_trip: { some: {} } },
] };
const PROVIDER_DOMAINS = {
  driver: { model: 'driver_profile', idField: 'driver_profile_id', userField: 'user_id', online: 'is_online', label: 'Rideshare drivers', extraWhere: rideshareDriverWhere },
  service: { model: 'user_service_provider', idField: 'provider_id', userField: 'user_id', online: 'is_online', active: 'is_active', label: 'Service providers' },
  worker: { model: 'worker_profile', idField: 'worker_profile_id', userField: 'user_id', online: 'is_available', label: 'On-demand workers' },
  courier: { model: 'driver_profile', idField: 'driver_profile_id', userField: 'user_id', online: 'is_online', label: 'Courier providers', extraWhere: { driver_courier_profile: { isNot: null } }, include: { driver_courier_profile: true } },
  food_delivery: { model: 'driver_profile', idField: 'driver_profile_id', userField: 'user_id', label: 'Delivery drivers', extraWhere: { driver_delivery_profile: { isNot: null } }, include: { driver_delivery_profile: true } },
  food_vendor: { model: 'food_vendor', idField: 'vendor_id', userField: 'owner_id', online: 'is_open', active: 'is_active', label: 'Food/grocery vendors' },
  appointment: { model: 'appointment_service_providers', idField: 'service_provider_id', userField: 'service_provider_user_id', label: 'Appointment providers' },
};

router.get('/providers', async (req, res) => {
  try {
    const domain = PROVIDER_DOMAINS[req.query.domain] ? req.query.domain : null;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
    const skip = (page - 1) * limit;
    const onlineOnly = req.query.online === 'true';
    const idleOnly = req.query.idle === 'true';

    // Supply summary across every domain (count + online count where a flag exists).
    const summary = [];
    for (const [key, d] of Object.entries(PROVIDER_DOMAINS)) {
      const model = prisma[d.model];
      const base = d.extraWhere || {};
      const total = await model.count({ where: base });
      let online = null;
      if (d.online) online = await model.count({ where: { ...base, [d.online]: true } });
      summary.push({ domain: key, label: d.label, total, online });
    }

    let directory = null;
    if (domain) {
      const d = PROVIDER_DOMAINS[domain];
      const model = prisma[d.model];
      const where = { ...(d.extraWhere || {}) };
      if (onlineOnly && d.online) where[d.online] = true;
      if (idleOnly && d.online) where[d.online] = false;
      const [rows, total] = await Promise.all([
        model.findMany({ where, skip, take: limit, orderBy: { [d.idField]: 'desc' }, include: d.include || undefined }),
        model.count({ where }),
      ]);
      const users = await userSummaries(rows.map((r) => r[d.userField]));
      directory = {
        domain, label: d.label,
        providers: rows.map((r) => ({
          id: r[d.idField],
          user: users[r[d.userField]] || null,
          online: d.online ? r[d.online] : null,
          active: d.active ? r[d.active] : null,
          rating: r.rating ?? null,
          name: r.vendor_name || r.company_name || r.courier_service_provider_name || r.driver_courier_profile?.display_name || null,
          last_ping: r.last_ping ?? null,
          created_at: r.created_at ?? null,
        })),
        pagination: { total, page, limit, pages: Math.ceil(total / limit) },
      };
    }

    res.json({
      summary,
      directory,
      note: 'Provider supply across every marketplace domain. Online counts use each table\'s availability flag (is_online / is_available / is_open); domains without a flag report supply only.',
    });
  } catch (err) {
    console.error('[board-admin/operations] providers error:', err);
    res.status(500).json({ successful: false, message: 'Could not load providers' });
  }
});

// ─── MATCHING (ride + work request lifecycle: match / fill / acceptance / timeout) ─
// The dispatch funnel that the order feed flattens away. ride_request + work_job carry
// the full request lifecycle (assigned vs declined vs timed-out), so this is the real
// backing for match rate, fill rate, acceptance rate, timeout events and response time.
const RIDE_COMPLETED = ['completed', 'succeeded', 'reconciled'];
const RIDE_CANCELLED = ['cancelled', 'frozen', 'rejected', 'failed', 'declined', 'expired', 'no_driver'];
const OPEN_RIDE = ['pending', 'pending_payment', 'requested', 'searching', 'offering', null];

function lifecycle(rows, now, { assignedKey, declinedKey, expiresKey }) {
  const requested = rows.length;
  let matched = 0, completed = 0, cancelled = 0, timedOut = 0, declines = 0;
  const byStatus = {};
  for (const r of rows) {
    const st = (r.status || 'unknown');
    byStatus[st] = (byStatus[st] || 0) + 1;
    if (r[assignedKey] != null) matched++;
    if (RIDE_COMPLETED.includes(r.status)) completed++;
    else if (RIDE_CANCELLED.includes(r.status)) cancelled++;
    const exp = expiresKey ? r[expiresKey] : null;
    if (r[assignedKey] == null && exp && new Date(exp) < now && OPEN_RIDE.includes(r.status)) timedOut++;
    declines += Array.isArray(r[declinedKey]) ? r[declinedKey].length : 0;
  }
  const rate = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  return {
    requested, matched, completed, cancelled, timedOut, declines,
    matchRate: rate(matched, requested),
    fillRate: rate(completed, requested),
    acceptanceRate: rate(matched, matched + declines),
    avgDeclines: requested ? Math.round((declines / requested) * 10) / 10 : 0,
    byStatus: Object.entries(byStatus).map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count),
  };
}

router.get('/matching', async (req, res) => {
  try {
    const days = clampInt(req.query.days, 1, 365, 30);
    const now = new Date();
    const cutoff = new Date(now.getTime() - days * 86400000);

    const [rides, jobs, responseRows, peakRows] = await Promise.all([
      prisma.ride_request.findMany({
        where: { created_at: { gte: cutoff } }, take: 10000,
        select: { status: true, assigned_driver_id: true, declined_driver_ids: true, offer_expires_at: true, created_at: true },
      }),
      prisma.work_job.findMany({
        where: { created_at: { gte: cutoff } }, take: 10000,
        select: { status: true, assigned_worker_id: true, declined_worker_ids: true, created_at: true },
      }),
      // response time = driver arrival − request time (seconds), on trips with an arrival stamp
      prisma.$queryRaw`
        SELECT AVG(EXTRACT(EPOCH FROM (t.driver_arrived_at - r.created_at)))::float AS avg_seconds,
               COUNT(*)::int AS measured
        FROM active_trip t JOIN ride_request r ON r.ride_request_id = t.request_id
        WHERE t.driver_arrived_at IS NOT NULL AND r.created_at >= ${cutoff}`,
      // demand by hour-of-day (peak windows) across rides + jobs
      prisma.$queryRaw`
        SELECT hour, SUM(c)::int AS count FROM (
          SELECT EXTRACT(HOUR FROM created_at)::int AS hour, COUNT(*)::int AS c FROM ride_request WHERE created_at >= ${cutoff} GROUP BY 1
          UNION ALL
          SELECT EXTRACT(HOUR FROM created_at)::int AS hour, COUNT(*)::int AS c FROM work_job WHERE created_at >= ${cutoff} GROUP BY 1
        ) h GROUP BY hour ORDER BY hour ASC`,
    ]);

    const rideshare = lifecycle(rides, now, { assignedKey: 'assigned_driver_id', declinedKey: 'declined_driver_ids', expiresKey: 'offer_expires_at' });
    const work = lifecycle(jobs, now, { assignedKey: 'assigned_worker_id', declinedKey: 'declined_worker_ids', expiresKey: null });
    const resp = responseRows[0] || {};
    const peak = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: num(peakRows.find((p) => p.hour === h)?.count) }));

    res.json({
      days,
      rideshare,
      work,
      responseTime: { avgSeconds: resp.avg_seconds == null ? null : Math.round(num(resp.avg_seconds)), measured: num(resp.measured) },
      peakWindows: peak,
      note: 'Dispatch funnel from ride_request + work_job. matchRate = requests that got an assigned provider; fillRate = requests that completed; acceptanceRate = matches ÷ (matches + total declines); timeouts = unassigned past offer expiry. Response time = driver arrival − request time.',
    });
  } catch (err) {
    console.error('[board-admin/operations] matching error:', err);
    res.status(500).json({ successful: false, message: 'Could not load matching data' });
  }
});

// ─── GEO (live operations map / heatmap points + spatial spread) ─────────────────
// Real coordinates: ride_request pickup_lat/long and work_job location_lat/long.
router.get('/geo', async (req, res) => {
  try {
    const days = clampInt(req.query.days, 1, 365, 30);
    const cutoff = new Date(Date.now() - days * 86400000);
    const [rides, jobs] = await Promise.all([
      prisma.ride_request.findMany({
        where: { created_at: { gte: cutoff }, pickup_lat: { not: null }, pickup_long: { not: null } },
        select: { ride_request_id: true, pickup_lat: true, pickup_long: true, pickup_address: true, status: true, estimated_fare: true, created_at: true },
        orderBy: { created_at: 'desc' }, take: 600,
      }),
      prisma.work_job.findMany({
        where: { created_at: { gte: cutoff }, location_lat: { not: null }, location_long: { not: null } },
        select: { work_job_id: true, location_lat: true, location_long: true, address: true, status: true, created_at: true },
        orderBy: { created_at: 'desc' }, take: 600,
      }),
    ]);
    res.json({
      days,
      ridePoints: rides.map((r) => ({ id: r.ride_request_id, lat: r.pickup_lat, lng: r.pickup_long, address: r.pickup_address, status: r.status, fare: num(r.estimated_fare), at: r.created_at })),
      workPoints: jobs.map((j) => ({ id: j.work_job_id, lat: j.location_lat, lng: j.location_long, address: j.address, status: j.status, at: j.created_at })),
      counts: { rides: rides.length, work: jobs.length },
      note: 'Live operations geography from request coordinates (ride_request pickup, work_job location). Capped at 600 most-recent points per domain. Addresses are free-text; structured city/country regional rollups live in the Vertical Management regional view.',
    });
  } catch (err) {
    console.error('[board-admin/operations] geo error:', err);
    res.status(500).json({ successful: false, message: 'Could not load geo data' });
  }
});

export default router;
