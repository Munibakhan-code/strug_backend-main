// routes/board-admin-finance-routes.js
//
// Read-only Finance (reporting half) data for the internal dashboards
// (strug-internal-dashboards). Gated by the board identity + can_manage_members
// (the admin tier) — mirrors the frontend RBAC where Finance is "Full Access" only.
//
// Mounted at /board-admin/finance. ALL endpoints are READ-ONLY — this is the
// REPORTING half of the Finance dashboard. The accounting/treasury/tax half
// (general ledger, journals, P&L, remittance) is NOT backed by the platform DB
// and stays an honest placeholder in the UI.
//
//   GET /board-admin/finance/overview      KPIs + daily wallet-flow series
//   GET /board-admin/finance/transactions  wallet_transaction ledger (filter/paginate)
//   GET /board-admin/finance/payouts        live + campaign payout queue
//   GET /board-admin/finance/wallets        strug_wallet balances overview + list
//   GET /board-admin/finance/revenue        gross revenue by vertical (paid orders)
//   GET /board-admin/finance/referrals      referral/cashback liabilities (wallet ledger)
//
// Money note: wallet_transaction is the platform's INTERNAL wallet ledger (live,
// ads, work, courier, rideshare, referral, subscriptions). The big commerce
// verticals (food/product/dg/rental/service) settle through their *_order tables
// + Stripe, so revenue-by-vertical aggregates those order tables directly. The two
// views are reported separately and labelled honestly so neither is mistaken for
// "all platform money".

import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateBoard, requireDashboard } from '../middleware/authenticate-board.js';
import { decrypt } from '../utils/crypto.js';
import { approvePayout, rejectPayout, markPaid } from '../services/live-payout.js';
import { approveCampaignPayout, rejectCampaignPayout, markCampaignPayoutPaid } from '../utils/raise-payout.js';
import bcrypt from 'bcrypt';
import { notify } from '../services/notify.js';

const router = express.Router();
router.use(authenticateBoard, requireDashboard('finance', 'read'));

// Prisma serializes Decimal as a string; coerce to Number for clean JSON.
const num = (d) => (d == null ? 0 : Number(d));
const clampInt = (v, lo, hi, dflt) => {
  const n = parseInt(v);
  if (Number.isNaN(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};

// user.email is encrypted at rest (deterministic AES). This board endpoint is
// authorized to display it (authenticateBoard + requireManageMembers); decrypt only
// hex-looking ciphertext so any legacy/plaintext rows pass through unchanged.
const looksEncrypted = (v) => typeof v === 'string' && v.length >= 32 && v.length % 2 === 0 && /^[0-9a-f]+$/i.test(v);
const decryptEmail = (v) => {
  if (!looksEncrypted(v)) return v;
  try { return decrypt(v); } catch { return v; }
};

// Resolve a compact display identity for a set of user_ids in one query.
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

// ─── OVERVIEW (KPIs + daily wallet-flow series) ─────────────────────────────────
router.get('/overview', async (req, res) => {
  try {
    const days = clampInt(req.query.days, 7, 180, 30);
    const cutoff = new Date(Date.now() - days * 86400000);

    const [
      walletSum, walletCount, negativeWallets, heldWallets, fundedWallets,
      txnTotal, txnWindow, creditsWindow, debitsWindow,
      livePending, refundsWindow, referralWindow, dailyRaw,
    ] = await Promise.all([
      prisma.strug_wallet.aggregate({ _sum: { balance: true } }),
      prisma.strug_wallet.count(),
      prisma.strug_wallet.count({ where: { balance: { lt: 0 } } }),
      prisma.strug_wallet.count({ where: { status: { not: 'active' } } }),
      prisma.strug_wallet.count({ where: { balance: { gt: 0 } } }),
      prisma.wallet_transaction.count(),
      prisma.wallet_transaction.aggregate({ _count: true, where: { created_at: { gte: cutoff } } }),
      prisma.wallet_transaction.aggregate({ _sum: { amount: true }, where: { type: 'credit', created_at: { gte: cutoff } } }),
      prisma.wallet_transaction.aggregate({ _sum: { amount: true }, where: { type: 'debit', created_at: { gte: cutoff } } }),
      prisma.live_payout_request.aggregate({ _sum: { amount: true }, _count: true, where: { status: 'PENDING' } }),
      prisma.wallet_transaction.aggregate({ _sum: { amount: true }, _count: true, where: { source: { contains: 'refund' }, created_at: { gte: cutoff } } }),
      prisma.wallet_transaction.aggregate({ _sum: { amount: true }, _count: true, where: { source: { in: ['recruit', 'referral'] }, created_at: { gte: cutoff } } }),
      prisma.$queryRaw`
        SELECT to_char(date_trunc('day', "created_at"), 'YYYY-MM-DD') AS date,
               SUM(CASE WHEN type = 'credit' THEN ABS(amount) ELSE 0 END)::float AS credit,
               SUM(CASE WHEN type = 'debit'  THEN ABS(amount) ELSE 0 END)::float AS debit,
               COUNT(*)::int AS count
        FROM "wallet_transaction"
        WHERE "created_at" >= ${cutoff}
        GROUP BY 1 ORDER BY 1
      `,
    ]);

    res.json({
      days,
      wallets: {
        totalBalance: num(walletSum._sum.balance),
        count: walletCount,
        funded: fundedWallets,
        negative: negativeWallets,
        nonActive: heldWallets,
      },
      transactions: {
        total: txnTotal,
        windowCount: txnWindow._count,
        creditVolume: num(creditsWindow._sum.amount),
        debitVolume: num(debitsWindow._sum.amount),
      },
      payoutQueue: {
        count: livePending._count,
        amount: num(livePending._sum.amount),
      },
      refunds: {
        count: refundsWindow._count,
        amount: num(refundsWindow._sum.amount),
      },
      referrals: {
        count: referralWindow._count,
        amount: num(referralWindow._sum.amount),
      },
      daily: dailyRaw, // [{ date, credit, debit, count }]
      note: 'Wallet flow = the internal wallet ledger only. Commerce GMV settles via the *_order tables (see /revenue).',
    });
  } catch (err) {
    console.error('[board-admin/finance] overview error:', err);
    res.status(500).json({ successful: false, message: 'Could not load finance overview' });
  }
});

// ─── TRANSACTIONS (wallet ledger) ───────────────────────────────────────────────
router.get('/transactions', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
    const skip = (page - 1) * limit;
    const { type, source, status, search } = req.query;
    const minAmount = req.query.minAmount != null ? Number(req.query.minAmount) : null;
    const days = req.query.days != null ? clampInt(req.query.days, 1, 365, 30) : null;

    const AND = [];
    if (type) AND.push({ type });
    if (source) AND.push({ source });
    if (status) AND.push({ status });
    // Refunds/reversals span multiple exact sources (e.g. ad_wallet_refund,
    // live_payout_refund) — match any source containing "refund".
    if (req.query.refunds === 'true') AND.push({ source: { contains: 'refund', mode: 'insensitive' } });
    if (minAmount != null && !Number.isNaN(minAmount)) AND.push({ amount: { gte: minAmount } });
    if (days != null) AND.push({ created_at: { gte: new Date(Date.now() - days * 86400000) } });
    if (search) {
      const term = String(search).trim();
      const asId = parseInt(term);
      const or = [{ description: { contains: term, mode: 'insensitive' } }, { source: { contains: term, mode: 'insensitive' } }];
      if (!Number.isNaN(asId)) or.push({ user_id: asId }, { transaction_id: asId });
      AND.push({ OR: or });
    }
    const where = AND.length ? { AND } : {};

    const [rows, total, sources] = await Promise.all([
      prisma.wallet_transaction.findMany({ where, skip, take: limit, orderBy: { transaction_id: 'desc' } }),
      prisma.wallet_transaction.count({ where }),
      prisma.wallet_transaction.groupBy({ by: ['source'], _count: { _all: true }, orderBy: { _count: { source: 'desc' } } }),
    ]);

    const users = await userSummaries(rows.map((r) => r.user_id));
    const transactions = rows.map((r) => ({
      transaction_id: r.transaction_id,
      user_id: r.user_id,
      user: users[r.user_id] || null,
      amount: num(r.amount),
      type: r.type,
      source: r.source,
      status: r.status,
      description: r.description,
      external_ref: r.external_ref,
      created_at: r.created_at,
    }));

    res.json({
      transactions,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
      sources: sources.map((s) => ({ source: s.source, count: s._count._all })),
    });
  } catch (err) {
    console.error('[board-admin/finance] transactions error:', err);
    res.status(500).json({ successful: false, message: 'Could not load transactions' });
  }
});

// ─── PAYOUTS (live streamer payouts + campaign/crowdfunding payouts) ─────────────
router.get('/payouts', async (req, res) => {
  try {
    const { status } = req.query; // PENDING | APPROVED | REJECTED | PAID (live), or completed (campaign)
    const liveStatus = status && ['PENDING', 'APPROVED', 'REJECTED', 'PAID'].includes(status) ? status : undefined;

    const [live, campaigns, liveByStatus] = await Promise.all([
      prisma.live_payout_request.findMany({
        where: liveStatus ? { status: liveStatus } : {},
        orderBy: { payout_id: 'desc' },
        take: 200,
        include: { streamer: { select: { user_id: true, display_name: true } } },
      }),
      liveStatus && liveStatus !== 'PAID'
        ? Promise.resolve([])
        : prisma.campaign_payout.findMany({ orderBy: { payout_id: 'desc' }, take: 100, include: { projects: { select: { project_name: true, title: true } } } }),
      prisma.live_payout_request.groupBy({ by: ['status'], _count: { _all: true }, _sum: { amount: true } }),
    ]);

    const recipientIds = [...live.map((p) => p.streamer?.user_id), ...campaigns.map((c) => c.owner_user_id)];
    const users = await userSummaries(recipientIds);

    const livePayouts = live.map((p) => ({
      id: `live-${p.payout_id}`,
      kind: 'live',
      label: 'Live streamer payout',
      amount: num(p.amount),
      fee: null,
      net: num(p.amount),
      status: p.status,
      note: p.admin_note,
      created_at: p.created_at,
      resolved_at: p.resolved_at || p.paid_at,
      recipient: p.streamer ? { ...(users[p.streamer.user_id] || { user_id: p.streamer.user_id }), display_name: p.streamer.display_name } : null,
    }));

    const campaignPayouts = campaigns.map((c) => ({
      id: `campaign-${c.payout_id}`,
      kind: 'campaign',
      label: c.projects?.title || c.projects?.project_name || 'Crowdfunding payout',
      amount: num(c.gross_amount),
      fee: num(c.fee_amount),
      net: num(c.net_amount),
      status: c.status,
      note: c.rejection_reason || null,
      created_at: c.created_at,
      resolved_at: c.paid_at || c.approved_at || c.reviewed_at || c.rejected_at || c.created_at,
      recipient: users[c.owner_user_id] || { user_id: c.owner_user_id },
    }));

    const byStatus = {};
    for (const g of liveByStatus) byStatus[g.status] = { count: g._count._all, amount: num(g._sum.amount) };

    res.json({
      payouts: [...livePayouts, ...campaignPayouts],
      live: { byStatus },
      campaignCount: campaignPayouts.length,
      note: 'Payouts cover live-streamer payout requests and crowdfunding payout requests. Campaign payouts now support pending review, approval, rejection, and paid states.',
    });
  } catch (err) {
    console.error('[board-admin/finance] payouts error:', err);
    res.status(500).json({ successful: false, message: 'Could not load payouts' });
  }
});

// ─── WALLETS (strug_wallet balances overview + list) ────────────────────────────
router.get('/wallets', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
    const skip = (page - 1) * limit;
    const sort = req.query.sort === 'lowest' ? 'asc' : 'desc';

    const [sum, count, byStatus, byCurrency, rows, total, negativeCount, fundedCount] = await Promise.all([
      prisma.strug_wallet.aggregate({ _sum: { balance: true }, _avg: { balance: true } }),
      prisma.strug_wallet.count(),
      prisma.strug_wallet.groupBy({ by: ['status'], _count: { _all: true }, _sum: { balance: true } }),
      prisma.strug_wallet.groupBy({ by: ['currency'], _count: { _all: true }, _sum: { balance: true } }),
      prisma.strug_wallet.findMany({ skip, take: limit, orderBy: { balance: sort } }),
      prisma.strug_wallet.count(),
      prisma.strug_wallet.count({ where: { balance: { lt: 0 } } }),
      prisma.strug_wallet.count({ where: { balance: { gt: 0 } } }),
    ]);

    const users = await userSummaries(rows.map((w) => w.user_id));
    const wallets = rows.map((w) => ({
      wallet_id: w.wallet_id,
      user_id: w.user_id,
      user: users[w.user_id] || null,
      balance: num(w.balance),
      currency: w.currency,
      status: w.status,
      updated_at: w.updated_at,
    }));

    res.json({
      summary: {
        totalBalance: num(sum._sum.balance),
        avgBalance: num(sum._avg.balance),
        count,
        funded: fundedCount,
        negative: negativeCount,
      },
      byStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all, balance: num(s._sum.balance) })),
      byCurrency: byCurrency.map((c) => ({ currency: c.currency, count: c._count._all, balance: num(c._sum.balance) })),
      wallets,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('[board-admin/finance] wallets error:', err);
    res.status(500).json({ successful: false, message: 'Could not load wallets' });
  }
});

// ─── REVENUE BY VERTICAL (paid orders + donations + ads/subscriptions) ──────────
router.get('/revenue', async (req, res) => {
  try {
    const days = clampInt(req.query.days, 7, 365, 90);
    const cutoff = new Date(Date.now() - days * 86400000);

    const [food, product, digital, rental, service, courier, donation, subs, adRev, booking, dailyRaw] = await Promise.all([
      // Food/Products also carry a recorded delivery_fee — summed here for the
      // Delivery Fees view (no extra query needed; folded into the existing aggregate).
      prisma.food_order.aggregate({ _sum: { total_amount: true, platform_fee: true, delivery_fee: true }, _count: true, where: { ispaid: true, created_at: { gte: cutoff } } }),
      prisma.product_order.aggregate({ _sum: { total: true, platform_fee: true, delivery_fee: true }, _count: true, where: { ispaid: true, order_time: { gte: cutoff } } }),
      prisma.dg_order.aggregate({ _sum: { total: true }, _count: true, where: { ispaid: true, date: { gte: cutoff } } }),
      prisma.rental_order.aggregate({ _sum: { total: true }, _count: true, where: { ispaid: true, date: { gte: cutoff } } }),
      prisma.service_order.aggregate({ _sum: { total: true }, _count: true, where: { ispaid: true, created_at: { gte: cutoff } } }),
      prisma.courier_order.aggregate({ _sum: { price: true }, _count: true, where: { is_paid: true, payment_time: { gte: cutoff } } }),
      prisma.donations.aggregate({ _sum: { amount: true }, _count: true, where: { payment_status: 'paid', donated_date: { gte: cutoff } } }),
      prisma.wallet_transaction.aggregate({ _sum: { amount: true }, _count: true, where: { source: 'live_subscription', type: 'credit', created_at: { gte: cutoff } } }),
      prisma.revenue_share_log.aggregate({ _sum: { platform_share: true, total_earned: true }, _count: true, where: { created_at: { gte: cutoff } } }),
      // Booking-engine bookings record a service_fee — summed for the Booking Fees view
      // (paid bookings only, same window).
      prisma.booking.aggregate({ _sum: { service_fee: true, total: true }, _count: true, where: { payment_status: 'paid', created_at: { gte: cutoff } } }),
      // Cross-vertical GMV by day — UNION of paid rows from each order table, using
      // the SAME paid-flag + date column as the per-vertical aggregates above so the
      // daily series reconciles to totalGMV. Date-typed columns cast to timestamp so
      // the UNION column has one uniform type.
      prisma.$queryRaw`
        SELECT to_char(date_trunc('day', d), 'YYYY-MM-DD') AS date,
               SUM(amount)::float AS gross,
               COUNT(*)::int AS orders
        FROM (
          SELECT created_at::timestamp AS d, total_amount AS amount FROM food_order WHERE ispaid = true AND created_at >= ${cutoff}
          UNION ALL
          SELECT order_time::timestamp, total FROM product_order WHERE ispaid = true AND order_time >= ${cutoff}
          UNION ALL
          SELECT date::timestamp, total FROM dg_order WHERE ispaid = true AND date >= ${cutoff}
          UNION ALL
          SELECT date::timestamp, total FROM rental_order WHERE ispaid = true AND date >= ${cutoff}
          UNION ALL
          SELECT created_at::timestamp, total FROM service_order WHERE ispaid = true AND created_at >= ${cutoff}
          UNION ALL
          SELECT payment_time::timestamp, price FROM courier_order WHERE is_paid = true AND payment_time >= ${cutoff}
          UNION ALL
          SELECT donated_date::timestamp, amount FROM donations WHERE payment_status = 'paid' AND donated_date >= ${cutoff}
          UNION ALL
          SELECT created_at::timestamp, amount FROM wallet_transaction WHERE source = 'live_subscription' AND type = 'credit' AND created_at >= ${cutoff}
          UNION ALL
          SELECT created_at::timestamp, total_earned FROM revenue_share_log WHERE created_at >= ${cutoff}
        ) t
        WHERE d IS NOT NULL
        GROUP BY 1 ORDER BY 1
      `,
    ]);

    const byVertical = [
      { vertical: 'Food', gross: num(food._sum.total_amount), platformFee: num(food._sum.platform_fee), orders: food._count, feeKnown: true },
      { vertical: 'Products', gross: num(product._sum.total), platformFee: num(product._sum.platform_fee), orders: product._count, feeKnown: true },
      { vertical: 'Digital goods', gross: num(digital._sum.total), platformFee: null, orders: digital._count, feeKnown: false },
      { vertical: 'Rentals', gross: num(rental._sum.total), platformFee: null, orders: rental._count, feeKnown: false },
      { vertical: 'Services', gross: num(service._sum.total), platformFee: null, orders: service._count, feeKnown: false },
      { vertical: 'Courier', gross: num(courier._sum.price), platformFee: null, orders: courier._count, feeKnown: false },
      { vertical: 'Donations', gross: num(donation._sum.amount), platformFee: null, orders: donation._count, feeKnown: false },
      { vertical: 'Live subscriptions', gross: num(subs._sum.amount), platformFee: null, orders: subs._count, feeKnown: false },
      { vertical: 'Video ads', gross: num(adRev._sum.total_earned), platformFee: num(adRev._sum.platform_share), orders: adRev._count, feeKnown: true },
    ].sort((a, b) => b.gross - a.gross);

    const totalGMV = byVertical.reduce((s, v) => s + v.gross, 0);
    const totalPlatformFee = byVertical.reduce((s, v) => s + (v.platformFee || 0), 0);
    const totalOrders = byVertical.reduce((s, v) => s + (v.orders || 0), 0);
    const aov = totalOrders ? totalGMV / totalOrders : 0;

    // Other recorded fees (distinct from the per-vertical platform_fee above):
    //   delivery — food_order/product_order.delivery_fee (charged on the order)
    //   booking  — booking.service_fee (booking-engine reservation fee)
    const foodDelivery = num(food._sum.delivery_fee);
    const productDelivery = num(product._sum.delivery_fee);
    const fees = {
      delivery: {
        food: { amount: foodDelivery, orders: food._count },
        products: { amount: productDelivery, orders: product._count },
        total: foodDelivery + productDelivery,
      },
      booking: { amount: num(booking._sum.service_fee), gross: num(booking._sum.total), count: booking._count },
    };

    res.json({
      days,
      byVertical,
      totalGMV,
      totalOrders,
      aov,
      knownPlatformFee: totalPlatformFee,
      fees, // { delivery:{food,products,total}, booking:{amount,gross,count} }
      daily: dailyRaw, // [{ date, gross, orders }] — cross-vertical GMV by day
      note: 'Gross = order/transaction value (GMV) for paid orders in the window. Platform fee is reported only where the platform records an explicit fee (Food, Products, Video ads); for the rest "gross" is the transaction volume, not net platform revenue. Delivery/booking fees are reported separately under `fees`.',
    });
  } catch (err) {
    console.error('[board-admin/finance] revenue error:', err);
    res.status(500).json({ successful: false, message: 'Could not load revenue' });
  }
});

// ─── REFERRALS / CASHBACK LIABILITIES (wallet ledger) ───────────────────────────
router.get('/referrals', async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    // Referral/cashback payouts live on the wallet ledger (source='referral'). No
    // separate cashback source exists today, so this is the referral incentive cost.
    const SOURCES = ['referral'];

    const [agg, byType, recent, refCodeCount, sharedCount] = await Promise.all([
      prisma.wallet_transaction.aggregate({ _sum: { amount: true }, _count: true, where: { source: { in: SOURCES } } }),
      prisma.wallet_transaction.groupBy({ by: ['type'], _count: { _all: true }, _sum: { amount: true }, where: { source: { in: SOURCES } } }),
      prisma.wallet_transaction.findMany({ where: { source: { in: SOURCES } }, orderBy: { transaction_id: 'desc' }, take: limit }),
      prisma.shared_ref_code.count().catch(() => null),
      prisma.user.count({ where: { ref_code: { not: null } } }).catch(() => null),
    ]);

    const users = await userSummaries(recent.map((r) => r.user_id));
    res.json({
      total: { amount: num(agg._sum.amount), count: agg._count },
      byType: byType.map((t) => ({ type: t.type, count: t._count._all, amount: num(t._sum.amount) })),
      referralCodes: refCodeCount,
      usersWithRefCode: sharedCount,
      recent: recent.map((r) => ({
        transaction_id: r.transaction_id,
        user_id: r.user_id,
        user: users[r.user_id] || null,
        amount: num(r.amount),
        type: r.type,
        status: r.status,
        description: r.description,
        created_at: r.created_at,
      })),
      note: 'Referral incentive cost from the wallet ledger (source="referral"). The platform has no separate cashback ledger today.',
    });
  } catch (err) {
    console.error('[board-admin/finance] referrals error:', err);
    res.status(500).json({ successful: false, message: 'Could not load referral liabilities' });
  }
});

// ═══════════════════ PAYOUT TRIGGERS (write-actions) ═══════════════════════════════
// The suite's first money-mutating actions. Board admins (requireManageMembers, already
// enforced router-wide) approve / reject / mark-paid live streamer payouts. All money
// movement reuses services/live-payout.js verbatim (idempotent Stripe Connect transfer,
// wallet refund on reject, status guards). Every action writes an append-only payout_audit
// row (who / action / status transition / amount / stripe transfer).

function loadPayoutFull(id) {
  return prisma.live_payout_request.findUnique({
    where: { payout_id: id },
    include: { streamer: { select: { streamer_id: true, user_id: true, handle: true, display_name: true, stripe_account_id: true } } },
  });
}
async function recordAudit({ payout, before, updated, actor, action }) {
  try {
    await prisma.payout_audit.create({
      data: {
        payout_id: payout.payout_id,
        actor_member_id: actor?.member_id ?? null,
        actor_name: actor?.name ?? null,
        action,
        from_status: before,
        to_status: updated?.status ?? before,
        amount: payout.amount,
        note: updated?.admin_note ?? null,
        stripe_transfer_id: updated?.stripe_transfer_id ?? null,
      },
    });
  } catch (e) {
    console.error('[board-admin/finance] payout audit write failed (non-fatal):', e.message);
  }
}
const payoutIdParam = (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ successful: false, message: 'Invalid payout id.' }); return null; }
  return id;
};

// GET /payouts/queue — the actionable live-payout queue (PENDING + APPROVED) with
// Connect eligibility so the UI can warn when Approve will move real money.
router.get('/payouts/queue', async (req, res) => {
  try {
    const rows = await prisma.live_payout_request.findMany({
      where: { status: { in: ['PENDING', 'APPROVED'] } },
      orderBy: { payout_id: 'desc' }, take: 200,
      include: { streamer: { select: { user_id: true, handle: true, display_name: true, stripe_account_id: true } } },
    });
    const users = await userSummaries(rows.map((r) => r.streamer?.user_id));
    const byStatus = await prisma.live_payout_request.groupBy({ by: ['status'], _count: { _all: true }, _sum: { amount: true } });
    res.json({
      queue: rows.map((p) => ({
        payout_id: p.payout_id, amount: num(p.amount), status: p.status, note: p.admin_note,
        created_at: p.created_at, resolved_at: p.resolved_at,
        connect: !!p.streamer?.stripe_account_id, // Approve auto-transfers only when true
        streamer: p.streamer ? { handle: p.streamer.handle, display_name: p.streamer.display_name, ...(users[p.streamer.user_id] || { user_id: p.streamer.user_id }) } : null,
      })),
      byStatus: byStatus.map((g) => ({ name: g.status, count: g._count._all, amount: num(g._sum.amount) })).sort((a, b) => b.count - a.count),
      note: 'Payout queue = live_payout_request rows awaiting action (PENDING / APPROVED). Approve auto-transfers via Stripe Connect when connect=true (real money), else marks APPROVED for manual disbursement.',
    });
  } catch (err) {
    console.error('[board-admin/finance] /payouts/queue error:', err);
    res.status(500).json({ successful: false, message: 'Could not load payout queue' });
  }
});

// GET /payouts/audit — recent payout write-action audit (optionally ?payout_id=).
router.get('/payouts/audit', async (req, res) => {
  try {
    const payoutId = Number(req.query.payout_id);
    const where = Number.isInteger(payoutId) && payoutId > 0 ? { payout_id: payoutId } : {};
    const rows = await prisma.payout_audit.findMany({ where, orderBy: { audit_id: 'desc' }, take: 100 });
    res.json({ audit: rows.map((a) => ({ ...a, amount: num(a.amount) })) });
  } catch (err) {
    console.error('[board-admin/finance] /payouts/audit error:', err);
    res.status(500).json({ successful: false, message: 'Could not load payout audit' });
  }
});

// Step-up re-authentication: the acting board member must re-type their own login
// password before any money-mutating action executes. Stateless (per-action), verified
// with bcrypt against the (globally-omitted) board_member.password. Reusable for any
// future real-money endpoint. Returns true on success; on failure sends the response
// (401/400) and returns false. INTERNAL-DASHBOARD payout endpoints only.
async function verifyStepUp(req, res) {
  const password = req.body?.password;
  if (!password || typeof password !== 'string') {
    res.status(400).json({ successful: false, message: 'Password required to authorize this action.' });
    return false;
  }
  const row = await prisma.board_member.findUnique({ where: { member_id: req.member.member_id }, omit: { password: false } });
  const ok = row?.password ? await bcrypt.compare(password, row.password) : false;
  if (!ok) {
    res.status(401).json({ successful: false, message: 'Incorrect password.' });
    return false;
  }
  return true;
}

// Streamer-facing copy per resolved payout status. APPROVED = queued for disbursement;
// PAID = money sent; REJECTED = held funds refunded to their wallet.
const PAYOUT_COPY = {
  PAID:     { type: 'payout.paid',     title: 'Your payout was sent',      body: 'The funds are on their way to your account.' },
  APPROVED: { type: 'payout.approved', title: 'Your payout was approved',  body: 'It is queued for disbursement.' },
  REJECTED: { type: 'payout.rejected', title: 'Your payout was rejected',  body: 'The held funds have been returned to your wallet.' },
};

async function handlePayoutAction(req, res, action, fn, extract) {
  const id = payoutIdParam(req, res);
  if (id === null) return;
  try {
    const payout = await loadPayoutFull(id);
    if (!payout) return res.status(404).json({ successful: false, message: 'Payout_Not_Found' });
    // Step-up password gate (all payout write-actions move / hold real money).
    if (!(await verifyStepUp(req, res))) {
      if (payout) await recordAudit({ payout, before: payout.status, updated: { status: payout.status, admin_note: `${action} DENIED — step-up password failed` }, actor: req.member, action: `${action}_denied` });
      return;
    }
    const before = payout.status;
    const updated = await fn(payout, extract(req));
    await recordAudit({ payout, before, updated, actor: req.member, action });

    // Tell the streamer what happened to their money. `payout.paid` is cited as the example type in
    // the notification schema and was fired by nothing — a payout could be approved, paid or
    // rejected (refunding held funds to their wallet) and they'd only find out by checking.
    // All three actions funnel through here, so this is the one place it needs to live.
    const copy = PAYOUT_COPY[updated.status];
    const recipient = payout.streamer?.user_id;
    if (copy && recipient) {
      notify(req.app.get('io'), {
        userId: recipient,
        vertical: 'payments',
        type: copy.type,
        title: copy.title,
        body: copy.body,
        urgency: 'ambient',
        entityType: 'live_payout_request',
        entityId: updated.payout_id,
        actionUrl: 'wallet',
      });
    }
    res.json({ successful: true, data: { payout_id: updated.payout_id, status: updated.status, stripe_transfer_id: updated.stripe_transfer_id ?? null, paid_at: updated.paid_at ?? null, resolved_at: updated.resolved_at ?? null } });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ successful: false, message: err.message });
    console.error(`[board-admin/finance] payout ${action} error:`, err);
    res.status(500).json({ successful: false, message: `Could not ${action} payout` });
  }
}

// POST /payouts/:id/approve — Connect transfer (→PAID) when eligible, else →APPROVED.
router.post('/payouts/:id/approve', requireDashboard('finance', 'write'), (req, res) => handlePayoutAction(req, res, 'approve', approvePayout, (r) => ({ note: r.body?.note })));
// POST /payouts/:id/reject — refund held funds to the streamer wallet (→REJECTED).
router.post('/payouts/:id/reject', requireDashboard('finance', 'write'), (req, res) => handlePayoutAction(req, res, 'reject', rejectPayout, (r) => ({ note: r.body?.note })));
// POST /payouts/:id/mark-paid — record a manual off-platform disbursement (→PAID).
router.post('/payouts/:id/mark-paid', requireDashboard('finance', 'write'), (req, res) => handlePayoutAction(req, res, 'mark_paid', markPaid, (r) => ({ reference: r.body?.reference })));

router.post('/campaign-payouts/:id/approve', requireDashboard('finance', 'write'), async (req, res) => {
  try {
    const result = await approveCampaignPayout(Number(req.params.id));
    if (!result.ok) return res.status(result.code || 400).json({ successful: false, message: result.message });
    res.json({ successful: true, data: result.payout });
  } catch (err) {
    console.error('[board-admin/finance] campaign payout approve error:', err);
    res.status(500).json({ successful: false, message: 'Could not approve campaign payout' });
  }
});

router.post('/campaign-payouts/:id/reject', requireDashboard('finance', 'write'), async (req, res) => {
  try {
    const result = await rejectCampaignPayout(Number(req.params.id), req.body?.note || null);
    if (!result.ok) return res.status(result.code || 400).json({ successful: false, message: result.message });
    res.json({ successful: true, data: result.payout });
  } catch (err) {
    console.error('[board-admin/finance] campaign payout reject error:', err);
    res.status(500).json({ successful: false, message: 'Could not reject campaign payout' });
  }
});

router.post('/campaign-payouts/:id/mark-paid', requireDashboard('finance', 'write'), async (req, res) => {
  try {
    const result = await markCampaignPayoutPaid(Number(req.params.id), req.body?.reference || null);
    if (!result.ok) return res.status(result.code || 400).json({ successful: false, message: result.message });
    res.json({ successful: true, data: result.payout });
  } catch (err) {
    console.error('[board-admin/finance] campaign payout mark-paid error:', err);
    res.status(500).json({ successful: false, message: 'Could not mark campaign payout paid' });
  }
});

export default router;
