// routes/board-admin-activity-routes.js
//
// Read-only "User Activity Intelligence" data for the internal dashboards
// (strug-internal-dashboards → User Management dashboard). Gated by the board
// identity + can_view_users — same tier as board-admin-users-routes.js.
//
// Mounted at /board-admin/activity. ALL endpoints are READ-ONLY.
//
//   GET /board-admin/activity/orders    recent orders unified across verticals
//   GET /board-admin/activity/bookings  recent bookings (stays + carpool)
//   GET /board-admin/activity/usage     platform usage summary (counts by vertical)
//
// Why a config-driven union: orders are fragmented across ~10 per-vertical tables
// (food_order, product_order, …) with inconsistent column names (user vs buyer_id,
// total vs price vs total_amount, ispaid vs is_paid, created_at vs order_time vs
// date). Each source is described once in ORDER_SOURCES and every query is wrapped
// so a single bad/empty table degrades to "no rows" instead of failing the feed.
// Field names verified against board-admin-finance-routes.js (the revenue aggregator).

import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateBoard, requireDashboard } from '../middleware/authenticate-board.js';
import { decrypt } from '../utils/crypto.js';

const router = express.Router();
router.use(authenticateBoard, requireDashboard('user-management', 'read'));

const num = (d) => (d == null ? 0 : Number(d));

// email decrypt (mirrors board-admin-users-routes.js — board is authorized to see it).
const looksEncrypted = (v) => typeof v === 'string' && v.length >= 32 && v.length % 2 === 0 && /^[0-9a-f]+$/i.test(v);
const decryptEmail = (v) => { if (!looksEncrypted(v)) return v; try { return decrypt(v); } catch { return v; } };
const withEmail = (u) => (u ? { ...u, email: decryptEmail(u.email) } : u);

// Per-vertical order tables. ts = the column used for recency ordering + display;
// total/status may be null when the table has no such column (handled below).
// `paid` derives a status string from the boolean when no status column exists.
const ORDER_SOURCES = [
  { vertical: 'Food',      model: 'food_order',            pk: 'food_order_id',            user: 'user_id',     total: 'total_amount', status: 'order_status', ts: 'created_at' },
  { vertical: 'Products',  model: 'product_order',         pk: 'order_id',                 user: 'buyer_id',    total: 'total',        status: 'status',       ts: 'order_time' },
  { vertical: 'Services',  model: 'service_order',         pk: 'order_id',                 user: 'buyer_id',    total: 'total',        status: 'status',       ts: 'created_at' },
  { vertical: 'Rentals',   model: 'rental_order',          pk: 'order_id',                 user: 'buyer_id',    total: 'total',        status: 'status',       ts: 'date' },
  { vertical: 'Digital',   model: 'dg_order',              pk: 'order_id',                 user: 'buyer_id',    total: 'total',        status: null,           ts: 'date',         paid: 'ispaid' },
  { vertical: 'Courier',   model: 'courier_order',         pk: 'courier_order_id',         user: 'customer_id', total: 'price',        status: 'status',       ts: 'pickup_date' },
  { vertical: 'Rideshare', model: 'ride_request',          pk: 'ride_request_id',          user: 'passenger_id', total: 'offered_fare', status: 'status',      ts: 'created_at' },
  { vertical: 'Places',    model: 'place_orders',          pk: 'place_order_id',           user: 'user_id',     total: 'price',        status: 'status',       ts: 'reserve_date' },
  { vertical: 'Cam Posts', model: 'cam_post_order',        pk: 'cam_post_order_id',        user: 'user_id',     total: null,           status: 'status',       ts: 'order_time' },
  { vertical: 'Lessons',   model: 'calm_lesson_order_buy', pk: 'calm_lesson_order_buy_id', user: 'user_id',     total: null,           status: 'status',       ts: 'order_time' },
];

const BOOKING_SOURCES = [
  { vertical: 'Bookings', model: 'booking',          pk: 'booking_id', user: 'guest_id',     total: 'total',      status: 'status', ts: 'created_at', verticalField: 'vertical' },
  { vertical: 'Carpool',  model: 'carpool_booking',  pk: 'booking_id', user: 'passenger_id', total: 'total_cost', status: 'status', ts: null },
];

// Fetch the most recent `take` rows from one source, normalized to a common shape.
async function fetchRecent(src, take) {
  const select = { [src.pk]: true, [src.user]: true };
  if (src.ts) select[src.ts] = true;
  if (src.total) select[src.total] = true;
  if (src.status) select[src.status] = true;
  if (src.paid) select[src.paid] = true;
  if (src.verticalField) select[src.verticalField] = true;
  const rows = await prisma[src.model].findMany({
    take,
    // Plain desc — `nulls: 'last'` throws on non-nullable timestamp columns
    // (e.g. service_order / booking), which would silently drop those sources.
    orderBy: src.ts ? { [src.ts]: 'desc' } : { [src.pk]: 'desc' },
    select,
  });
  return rows.map((r) => ({
    vertical: src.verticalField && r[src.verticalField] ? r[src.verticalField] : src.vertical,
    source: src.model,
    order_id: r[src.pk],
    user_id: r[src.user] ?? null,
    amount: src.total ? num(r[src.total]) : null,
    status: src.status ? (r[src.status] || null) : (src.paid ? (r[src.paid] ? 'paid' : 'unpaid') : null),
    created_at: src.ts ? (r[src.ts] || null) : null,
  }));
}

// Merge + sort + paginate a set of sources, then hydrate the buyer user.
async function buildFeed(sources, { page, limit, status }) {
  const take = Math.min(300, page * limit); // bounded window per source
  const chunks = await Promise.all(sources.map(async (s) => {
    try { return await fetchRecent(s, take); }
    catch (e) { console.error('[board-admin/activity]', s.model, 'skipped:', e?.message || e); return []; }
  }));
  let merged = chunks.flat();
  if (status) merged = merged.filter((o) => (o.status || '').toLowerCase() === String(status).toLowerCase());
  merged.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

  const byVertical = {};
  for (const o of merged) byVertical[o.vertical] = (byVertical[o.vertical] || 0) + 1;

  const start = (page - 1) * limit;
  const slice = merged.slice(start, start + limit);

  const ids = [...new Set(slice.map((o) => o.user_id).filter((v) => v != null))];
  const users = ids.length
    ? await prisma.user.findMany({ where: { user_id: { in: ids } }, select: { user_id: true, name: true, username: true, email: true } })
    : [];
  const umap = new Map(users.map((u) => [u.user_id, withEmail(u)]));

  return {
    rows: slice.map((o) => ({ ...o, user: o.user_id != null ? (umap.get(o.user_id) || null) : null })),
    byVertical: Object.entries(byVertical).map(([vertical, count]) => ({ vertical, count })).sort((a, b) => b.count - a.count),
    pagination: { page, limit, windowCount: merged.length, hasMore: merged.length > start + limit },
  };
}

// ─── ORDERS ──────────────────────────────────────────────────────────────────
router.get('/orders', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 25));
    const { vertical, status } = req.query;
    const sources = vertical ? ORDER_SOURCES.filter((s) => s.vertical === vertical) : ORDER_SOURCES;
    const feed = await buildFeed(sources, { page, limit, status });
    res.json({ orders: feed.rows, byVertical: feed.byVertical, pagination: feed.pagination });
  } catch (err) {
    console.error('[board-admin/activity] orders error:', err);
    res.status(500).json({ successful: false, message: 'Could not load orders feed' });
  }
});

// ─── BOOKINGS ────────────────────────────────────────────────────────────────
router.get('/bookings', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 25));
    const { vertical, status } = req.query;
    const sources = vertical ? BOOKING_SOURCES.filter((s) => s.vertical === vertical) : BOOKING_SOURCES;
    const feed = await buildFeed(sources, { page, limit, status });
    res.json({ bookings: feed.rows, byVertical: feed.byVertical, pagination: feed.pagination });
  } catch (err) {
    console.error('[board-admin/activity] bookings error:', err);
    res.status(500).json({ successful: false, message: 'Could not load bookings feed' });
  }
});

// ─── USAGE SUMMARY ───────────────────────────────────────────────────────────
// Total + last-30-day counts per vertical (orders & bookings), so the dashboard
// can show where platform activity concentrates without a true union query.
router.get('/usage', async (_req, res) => {
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const countSource = async (src) => {
      try {
        const total = await prisma[src.model].count();
        const last30d = src.ts ? await prisma[src.model].count({ where: { [src.ts]: { gte: cutoff } } }) : null;
        return { vertical: src.vertical, model: src.model, total, last30d };
      } catch (e) {
        console.error('[board-admin/activity] usage', src.model, 'skipped:', e?.message || e);
        return { vertical: src.vertical, model: src.model, total: 0, last30d: 0, unavailable: true };
      }
    };
    const [orders, bookings] = await Promise.all([
      Promise.all(ORDER_SOURCES.map(countSource)),
      Promise.all(BOOKING_SOURCES.map(countSource)),
    ]);
    const sum = (arr, k) => arr.reduce((a, r) => a + (r[k] || 0), 0);
    res.json({
      orders: orders.sort((a, b) => b.total - a.total),
      bookings: bookings.sort((a, b) => b.total - a.total),
      totals: {
        orders: sum(orders, 'total'), ordersLast30d: sum(orders, 'last30d'),
        bookings: sum(bookings, 'total'), bookingsLast30d: sum(bookings, 'last30d'),
      },
      note: 'Orders settle across ~10 per-vertical tables; counts are per source. last30d is by each table’s order/created timestamp.',
    });
  } catch (err) {
    console.error('[board-admin/activity] usage error:', err);
    res.status(500).json({ successful: false, message: 'Could not load usage summary' });
  }
});

// ─── MESSAGES ACTIVITY (counts-only) ─────────────────────────────────────────
// Per-user messaging *activity* — counts, not content. Message bodies
// (chat_messages.content) are deliberately NEVER read. Surfaces: totals, the most
// active senders (resolved to a user so an admin can jump to the profile), channel
// mix (dm vs group) and daily message volume. Backs the "Messages Activity" view.
router.get('/messages', async (_req, res) => {
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const notDeleted = { deleted_at: null };
    const [
      totalMessages, messagesLast30d, totalChannels, activeParticipants, senderGroups, byType, topSenderGroups,
    ] = await Promise.all([
      prisma.chat_messages.count({ where: notDeleted }),
      prisma.chat_messages.count({ where: { ...notDeleted, sent_at: { gte: cutoff } } }),
      prisma.chat_channel.count(),
      prisma.chat_participants.count({ where: { left_at: null } }),
      prisma.chat_messages.groupBy({ by: ['sender_id'], where: { ...notDeleted, sender_id: { not: null } }, _count: { _all: true } }),
      prisma.chat_channel.groupBy({ by: ['type'], _count: { _all: true } }),
      prisma.chat_messages.groupBy({
        by: ['sender_id'],
        where: { ...notDeleted, sender_id: { not: null } },
        _count: { _all: true },
        _max: { sent_at: true },
        orderBy: { _count: { sender_id: 'desc' } },
        take: 20,
      }),
    ]);

    // Resolve the top senders to a user (username / name + decrypted email).
    const ids = topSenderGroups.map((g) => g.sender_id).filter((v) => v != null);
    const usersList = ids.length
      ? await prisma.user.findMany({ where: { user_id: { in: ids } }, select: { user_id: true, username: true, name: true, email: true } })
      : [];
    const byId = new Map(usersList.map((u) => [u.user_id, u]));
    const topSenders = topSenderGroups.map((g) => {
      const u = byId.get(g.sender_id);
      return {
        user_id: g.sender_id,
        username: u?.username || null,
        name: u?.name || null,
        email: u ? decryptEmail(u.email) : null,
        messages: g._count._all,
        lastSentAt: g._max.sent_at,
      };
    });

    // Daily message volume over the window (no content read).
    let daily = [];
    try {
      const rows = await prisma.$queryRaw`
        SELECT date_trunc('day', sent_at) AS day, COUNT(*)::int AS count
        FROM chat_messages
        WHERE sent_at >= ${cutoff} AND deleted_at IS NULL
        GROUP BY 1 ORDER BY 1 ASC`;
      daily = rows.map((r) => ({ day: r.day, count: num(r.count) }));
    } catch (e) {
      console.error('[board-admin/activity] messages daily skipped:', e?.message || e);
    }

    res.json({
      totals: {
        messages: totalMessages,
        messagesLast30d,
        channels: totalChannels,
        activeParticipants,
        senders: senderGroups.length, // distinct users who have sent at least one message
      },
      byType: byType.map((t) => ({ type: t.type || 'unknown', count: t._count._all })).sort((a, b) => b.count - a.count),
      topSenders,
      daily,
      note: 'Messaging activity is counts-only — message content (chat_messages.content) is never read. "Senders" = distinct users with ≥1 message; channel mix is dm vs group.',
    });
  } catch (err) {
    console.error('[board-admin/activity] messages error:', err);
    res.status(500).json({ successful: false, message: 'Could not load messaging activity' });
  }
});

// ─── GLOBAL SEARCH ───────────────────────────────────────────────────────────
// Resolve any identifier the admin pastes (username / email / ref code, or a
// numeric user / wallet / transaction / order / booking id) to the records and,
// crucially, the OWNING USER so they can jump to a profile. Each lookup is wrapped
// so a missing table never fails the whole search.
async function searchUsersByText(term, limit = 20) {
  // email is encrypted at rest → resolve email matches in-app (same approach as the
  // users list endpoint; cheap at current scale).
  const t = term.toLowerCase();
  const allEmails = await prisma.user.findMany({ select: { user_id: true, email: true } });
  const emailIds = allEmails.filter((u) => decryptEmail(u.email)?.toLowerCase().includes(t)).map((u) => u.user_id);
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { username: { contains: term, mode: 'insensitive' } },
        { name: { contains: term, mode: 'insensitive' } },
        { ref_code: { contains: term, mode: 'insensitive' } },
        { user_id: { in: emailIds } },
      ],
    },
    take: limit,
    orderBy: { user_id: 'desc' },
    select: { user_id: true, name: true, username: true, email: true, ref_code: true, role: true },
  });
  return users.map(withEmail);
}

router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const out = { q, users: [], orders: [], bookings: [], wallets: [], transactions: [] };
    if (!q) return res.json(out);

    const asId = /^\d+$/.test(q) ? parseInt(q, 10) : null;

    // Always run the text search (covers username/email/name/ref code).
    try { out.users = await searchUsersByText(q); }
    catch (e) { console.error('[board-admin/activity] search users:', e?.message || e); }

    if (asId != null) {
      const tryFind = async (fn, label) => { try { return await fn(); } catch (e) { console.error('[board-admin/activity] search', label, e?.message || e); return null; } };

      // Exact user by id (merge into users if not already present).
      const byId = await tryFind(() => prisma.user.findUnique({ where: { user_id: asId }, select: { user_id: true, name: true, username: true, email: true, ref_code: true, role: true } }), 'user-id');
      if (byId && !out.users.some((u) => u.user_id === byId.user_id)) out.users.unshift(withEmail(byId));

      // Wallet by wallet_id, transaction by transaction_id.
      const wallet = await tryFind(() => prisma.strug_wallet.findUnique({ where: { wallet_id: asId }, select: { wallet_id: true, user_id: true, balance: true, currency: true, status: true } }), 'wallet');
      if (wallet) out.wallets.push({ ...wallet, balance: num(wallet.balance) });
      const txn = await tryFind(() => prisma.wallet_transaction.findUnique({ where: { transaction_id: asId }, select: { transaction_id: true, user_id: true, amount: true, type: true, source: true, status: true, created_at: true } }), 'transaction');
      if (txn) out.transactions.push({ ...txn, amount: num(txn.amount) });

      // Order / booking by primary key across every per-vertical table.
      for (const src of ORDER_SOURCES) {
        const row = await tryFind(() => prisma[src.model].findUnique({ where: { [src.pk]: asId }, select: { [src.pk]: true, [src.user]: true } }), `order:${src.model}`);
        if (row) out.orders.push({ vertical: src.vertical, source: src.model, order_id: row[src.pk], user_id: row[src.user] ?? null });
      }
      for (const src of BOOKING_SOURCES) {
        const sel = { [src.pk]: true, [src.user]: true };
        if (src.verticalField) sel[src.verticalField] = true;
        const row = await tryFind(() => prisma[src.model].findUnique({ where: { [src.pk]: asId }, select: sel }), `booking:${src.model}`);
        if (row) out.bookings.push({ vertical: src.verticalField && row[src.verticalField] ? row[src.verticalField] : src.vertical, source: src.model, order_id: row[src.pk], user_id: row[src.user] ?? null });
      }
    }

    // Hydrate the owning user for every entity result.
    const ids = [...new Set([...out.orders, ...out.bookings, ...out.wallets, ...out.transactions].map((r) => r.user_id).filter((v) => v != null))];
    if (ids.length) {
      const users = await prisma.user.findMany({ where: { user_id: { in: ids } }, select: { user_id: true, name: true, username: true, email: true } });
      const umap = new Map(users.map((u) => [u.user_id, withEmail(u)]));
      const attach = (r) => ({ ...r, user: r.user_id != null ? (umap.get(r.user_id) || null) : null });
      out.orders = out.orders.map(attach);
      out.bookings = out.bookings.map(attach);
      out.wallets = out.wallets.map(attach);
      out.transactions = out.transactions.map(attach);
    }

    res.json(out);
  } catch (err) {
    console.error('[board-admin/activity] search error:', err);
    res.status(500).json({ successful: false, message: 'Could not run search' });
  }
});

export default router;
