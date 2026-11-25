// routes/board-admin-marketing-routes.js
//
// Read-only Marketing / Advertising data for the internal dashboards
// (strug-internal-dashboards → Marketing API dashboard). Gated by the board identity
// + can_manage_members (the admin tier — exposes advertiser identity + emails),
// matching Finance / … / Payments & Risks. Mounted at /board-admin/marketing.
// ALL endpoints READ-ONLY (campaign create/pause/moderate stay in the app ads routes).
//
// The platform ad stack is real and rich, so most of this is genuinely wireable:
//   ads_campaign          the campaign (status / objective / ad_type / budgets / spend /
//                         targeting / safety / main_category)
//   ad_impressions        the performance event stream (impression / click +
//                         revenue_generated per event) → impressions / clicks / CTR / spend
//   ads_wallet            advertiser ad balance (+ wallet_transaction ad_wallet_topup /
//                         ad_wallet_withdrawal / ad_campaign ledger rows)
//   ads_account_profile   the advertiser company account (business_name / status /
//                         setup / billing_threshold) + ads_brand_profile + ads_member
//   revenue_share_log     creator ad-revenue split (total / creator / platform share)
//
// What genuinely does NOT exist (→ honest N/A in the dashboard): audience-segment /
// lookalike builder, A/B creative testing, conversion pixels / attribution, bid-
// optimization ML, RTB / ad-exchange, agency accounts, creative-asset library,
// invoicing / payment-methods. Some campaign fields exist but are unused at serve time
// (frequency_cap, geofence, dayparting, connected_channels) — those stay N/A too.

import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateBoard, requireDashboard } from '../middleware/authenticate-board.js';
import { decrypt } from '../utils/crypto.js';

const router = express.Router();
router.use(authenticateBoard, requireDashboard('marketing-api', 'read'));

const num = (d) => (d == null ? 0 : Number(d));
const clampInt = (v, lo, hi, dflt) => {
  const n = parseInt(v);
  if (Number.isNaN(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
const mapGroup = (rows, key) =>
  rows.map((r) => ({ name: r[key] == null ? '(none)' : String(r[key]), count: num(r._count?._all) }))
    .sort((a, b) => b.count - a.count);

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
    select: { user_id: true, name: true, username: true, email: true },
  });
  const map = {};
  for (const u of users) map[u.user_id] = { user_id: u.user_id, name: u.name, username: u.username, email: decryptEmail(u.email) };
  return map;
}
// Map ads_wallet_id → owning user summary (campaigns carry ads_wallet_id, not user_id).
async function walletOwners(walletIds) {
  const unique = [...new Set(walletIds.filter((x) => x != null))];
  if (!unique.length) return {};
  const wallets = await prisma.ads_wallet.findMany({ where: { ads_wallet_id: { in: unique } }, select: { ads_wallet_id: true, user_id: true } });
  const users = await userSummaries(wallets.map((w) => w.user_id));
  const map = {};
  for (const w of wallets) map[w.ads_wallet_id] = users[w.user_id] || { user_id: w.user_id };
  return map;
}

const ctr = (clicks, impressions) => (impressions > 0 ? +((clicks / impressions) * 100).toFixed(2) : 0);

// ─────────────────────────────────────────────────────────────────────────────────────
// GET /overview — the marketing rollup.  ?days=N (perf/trend window, default 30)
// ─────────────────────────────────────────────────────────────────────────────────────
router.get('/overview', async (req, res) => {
  try {
    const days = clampInt(req.query.days, 1, 365, 30);
    const cutoff = daysAgo(days);

    const [
      total, byStatus, byObjective, byType, byCategory,
      spendAgg, budgetAgg,
      walletCount, walletSum,
      impressions, clicks, spendPerf,
      acctTotal, acctByStatus,
      pendingReview, flagged,
      revShare,
    ] = await Promise.all([
      prisma.ads_campaign.count(),
      prisma.ads_campaign.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.ads_campaign.groupBy({ by: ['objective'], _count: { _all: true } }),
      prisma.ads_campaign.groupBy({ by: ['ad_type'], _count: { _all: true } }),
      prisma.ads_campaign.groupBy({ by: ['main_category'], _count: { _all: true } }),
      prisma.ads_campaign.aggregate({ _sum: { total_spent: true, spent_today: true } }),
      prisma.ads_campaign.aggregate({ _sum: { daily_budget: true, total_budget: true } }),
      prisma.ads_wallet.count(),
      prisma.ads_wallet.aggregate({ _sum: { balance: true } }),
      prisma.ad_impressions.count({ where: { event_type: 'impression', created_at: { gte: cutoff } } }),
      prisma.ad_impressions.count({ where: { event_type: 'click', created_at: { gte: cutoff } } }),
      prisma.ad_impressions.aggregate({ _sum: { revenue_generated: true }, where: { created_at: { gte: cutoff } } }),
      prisma.ads_account_profile.count(),
      prisma.ads_account_profile.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.ads_campaign.count({ where: { status: 'PENDING_REVIEW' } }),
      prisma.ads_campaign.count({ where: { OR: [{ is_sensitive: true }, { safety_score: { lt: 1 } }] } }),
      prisma.revenue_share_log.aggregate({ _sum: { total_earned: true, creator_share: true, platform_share: true } }),
    ]);

    const dailySpend = await prisma.$queryRaw`
      SELECT date_trunc('day', created_at)::date AS day,
             SUM(revenue_generated)::float AS spend,
             COUNT(*) FILTER (WHERE event_type = 'impression')::int AS impressions,
             COUNT(*) FILTER (WHERE event_type = 'click')::int AS clicks
      FROM ad_impressions WHERE created_at >= ${cutoff}
      GROUP BY 1 ORDER BY 1 ASC`;

    res.json({
      days,
      campaigns: {
        total,
        byStatus: mapGroup(byStatus, 'status'),
        byObjective: mapGroup(byObjective, 'objective'),
        byType: mapGroup(byType, 'ad_type'),
        byCategory: mapGroup(byCategory, 'main_category'),
        pendingReview, flagged,
      },
      spend: { total: num(spendAgg._sum.total_spent), today: num(spendAgg._sum.spent_today) },
      budget: { daily: num(budgetAgg._sum.daily_budget), total: num(budgetAgg._sum.total_budget) },
      wallets: { count: walletCount, balance: num(walletSum._sum.balance) },
      performance: {
        impressions, clicks, ctr: ctr(clicks, impressions),
        spend: num(spendPerf._sum.revenue_generated),
      },
      advertisers: { total: acctTotal, byStatus: mapGroup(acctByStatus, 'status') },
      revenue: {
        total: num(revShare._sum.total_earned),
        creatorShare: num(revShare._sum.creator_share),
        platformShare: num(revShare._sum.platform_share),
      },
      daily: dailySpend.map((d) => ({ day: d.day, spend: num(d.spend), impressions: num(d.impressions), clicks: num(d.clicks) })),
      note: 'Marketing overview = a read-only rollup across the ad stack (campaigns, ad_impressions performance, ads wallets, advertiser accounts, revenue share). Campaign create / pause / moderate are writes in the app ads routes.',
    });
  } catch (err) {
    console.error('[board-admin/marketing] /overview failed:', err);
    res.status(500).json({ error: 'Failed to load marketing overview' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────
// GET /campaigns — the campaign feed.
//   ?status= ?objective= ?ad_type= ?category=(main_category) ?search= ?page= ?limit=
// ─────────────────────────────────────────────────────────────────────────────────────
router.get('/campaigns', async (req, res) => {
  try {
    const page = clampInt(req.query.page, 1, 100000, 1);
    const limit = clampInt(req.query.limit, 1, 100, 25);
    const where = {};
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.objective) where.objective = String(req.query.objective);
    if (req.query.ad_type) where.ad_type = String(req.query.ad_type);
    if (req.query.category) where.main_category = String(req.query.category);
    if (req.query.search) where.title = { contains: String(req.query.search), mode: 'insensitive' };

    const [total, rows, byStatus] = await Promise.all([
      prisma.ads_campaign.count({ where }),
      prisma.ads_campaign.findMany({
        where, orderBy: { created_at: 'desc' }, skip: (page - 1) * limit, take: limit,
        select: {
          campaign_id: true, ads_wallet_id: true, title: true, ad_type: true, objective: true,
          vertical: true, main_category: true, status: true, bid_type: true, bid_amount: true,
          daily_budget: true, total_budget: true, spent_today: true, total_spent: true,
          target_countries: true, target_interests: true, is_sensitive: true, safety_score: true,
          created_at: true,
        },
      }),
      prisma.ads_campaign.groupBy({ by: ['status'], _count: { _all: true }, where }),
    ]);

    const owners = await walletOwners(rows.map((r) => r.ads_wallet_id));
    res.json({
      total,
      pagination: { page, limit, pages: Math.ceil(total / limit) },
      byStatus: mapGroup(byStatus, 'status'),
      filters: { status: req.query.status || null, objective: req.query.objective || null, ad_type: req.query.ad_type || null, category: req.query.category || null, search: req.query.search || null },
      campaigns: rows.map((c) => ({
        campaign_id: c.campaign_id, title: c.title, ad_type: c.ad_type, objective: c.objective,
        vertical: c.vertical, main_category: c.main_category, status: c.status,
        bid_type: c.bid_type, bid_amount: num(c.bid_amount),
        daily_budget: num(c.daily_budget), total_budget: num(c.total_budget),
        spent_today: num(c.spent_today), total_spent: num(c.total_spent),
        target_countries: c.target_countries, target_interests: c.target_interests,
        is_sensitive: c.is_sensitive, safety_score: c.safety_score, created_at: c.created_at,
        advertiser: owners[c.ads_wallet_id] || null,
      })),
    });
  } catch (err) {
    console.error('[board-admin/marketing] /campaigns failed:', err);
    res.status(500).json({ error: 'Failed to load campaigns' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────
// GET /performance — ad_impressions aggregates.  ?days=N (default 30)
// ─────────────────────────────────────────────────────────────────────────────────────
router.get('/performance', async (req, res) => {
  try {
    const days = clampInt(req.query.days, 1, 365, 30);
    const cutoff = daysAgo(days);

    const [impressions, clicks, spendAgg, byEvent] = await Promise.all([
      prisma.ad_impressions.count({ where: { event_type: 'impression', created_at: { gte: cutoff } } }),
      prisma.ad_impressions.count({ where: { event_type: 'click', created_at: { gte: cutoff } } }),
      prisma.ad_impressions.aggregate({ _sum: { revenue_generated: true }, where: { created_at: { gte: cutoff } } }),
      prisma.ad_impressions.groupBy({ by: ['event_type'], _count: { _all: true }, where: { created_at: { gte: cutoff } } }),
    ]);

    const daily = await prisma.$queryRaw`
      SELECT date_trunc('day', created_at)::date AS day,
             SUM(revenue_generated)::float AS spend,
             COUNT(*) FILTER (WHERE event_type = 'impression')::int AS impressions,
             COUNT(*) FILTER (WHERE event_type = 'click')::int AS clicks
      FROM ad_impressions WHERE created_at >= ${cutoff}
      GROUP BY 1 ORDER BY 1 ASC`;

    // Top campaigns by spend (ad_id → ads_campaign.campaign_id).
    const topRaw = await prisma.ad_impressions.groupBy({
      by: ['ad_id'], _sum: { revenue_generated: true }, _count: { _all: true },
      where: { created_at: { gte: cutoff } },
      orderBy: { _sum: { revenue_generated: 'desc' } }, take: 15,
    });
    const camps = await prisma.ads_campaign.findMany({ where: { campaign_id: { in: topRaw.map((t) => t.ad_id) } }, select: { campaign_id: true, title: true, status: true } });
    const campMap = Object.fromEntries(camps.map((c) => [c.campaign_id, c]));

    res.json({
      days,
      totals: { impressions, clicks, ctr: ctr(clicks, impressions), spend: num(spendAgg._sum.revenue_generated) },
      byEvent: mapGroup(byEvent, 'event_type'),
      daily: daily.map((d) => ({ day: d.day, spend: num(d.spend), impressions: num(d.impressions), clicks: num(d.clicks) })),
      topCampaigns: topRaw.map((t) => ({
        campaign_id: t.ad_id, title: campMap[t.ad_id]?.title || `Campaign #${t.ad_id}`,
        status: campMap[t.ad_id]?.status || null, spend: num(t._sum.revenue_generated), events: num(t._count._all),
      })),
      note: 'Performance = the ad_impressions event stream (impression / click + revenue_generated per event). Spend is the advertiser cost accrued. There is no conversion / attribution pixel, so no conversion or ROAS-attribution metric is shown.',
    });
  } catch (err) {
    console.error('[board-admin/marketing] /performance failed:', err);
    res.status(500).json({ error: 'Failed to load performance' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────
// GET /advertisers — ads_account_profile feed.  ?status= ?page= ?limit=
// ─────────────────────────────────────────────────────────────────────────────────────
router.get('/advertisers', async (req, res) => {
  try {
    const page = clampInt(req.query.page, 1, 100000, 1);
    const limit = clampInt(req.query.limit, 1, 100, 25);
    const where = {};
    if (req.query.status) where.status = String(req.query.status);

    const [total, rows, byStatus] = await Promise.all([
      prisma.ads_account_profile.count({ where }),
      prisma.ads_account_profile.findMany({
        where, orderBy: { created_at: 'desc' }, skip: (page - 1) * limit, take: limit,
        select: {
          profile_id: true, user_id: true, business_name: true, status: true,
          setup_completed: true, billing_threshold: true, sandbox_enabled: true, created_at: true,
          _count: { select: { brands: true, members: true } },
        },
      }),
      prisma.ads_account_profile.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);

    const users = await userSummaries(rows.map((r) => r.user_id));
    res.json({
      total,
      pagination: { page, limit, pages: Math.ceil(total / limit) },
      byStatus: mapGroup(byStatus, 'status'),
      filters: { status: req.query.status || null },
      advertisers: rows.map((a) => ({
        profile_id: a.profile_id, business_name: a.business_name, status: a.status,
        setup_completed: a.setup_completed, billing_threshold: num(a.billing_threshold),
        sandbox_enabled: a.sandbox_enabled, brands: a._count.brands, members: a._count.members,
        created_at: a.created_at, owner: users[a.user_id] || null,
      })),
      note: 'Advertisers = the ads_account_profile company accounts (with brand + team-member counts). Approval is a write in the app ads-account route; this view is read-only.',
    });
  } catch (err) {
    console.error('[board-admin/marketing] /advertisers failed:', err);
    res.status(500).json({ error: 'Failed to load advertisers' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────
// GET /wallets — ads_wallet balances + top-up / withdrawal ledger.  ?page= ?limit=
// ─────────────────────────────────────────────────────────────────────────────────────
router.get('/wallets', async (req, res) => {
  try {
    const page = clampInt(req.query.page, 1, 100000, 1);
    const limit = clampInt(req.query.limit, 1, 100, 25);

    const [count, sum, byStatus, rows, topups, withdrawals, ledger] = await Promise.all([
      prisma.ads_wallet.count(),
      prisma.ads_wallet.aggregate({ _sum: { balance: true } }),
      prisma.ads_wallet.groupBy({ by: ['status'], _count: { _all: true }, _sum: { balance: true } }),
      prisma.ads_wallet.findMany({ orderBy: { balance: 'desc' }, skip: (page - 1) * limit, take: limit, select: { ads_wallet_id: true, user_id: true, balance: true, currency: true, status: true, updated_at: true } }),
      prisma.wallet_transaction.aggregate({ _count: { _all: true }, _sum: { amount: true }, where: { source: 'ad_wallet_topup' } }),
      prisma.wallet_transaction.aggregate({ _count: { _all: true }, _sum: { amount: true }, where: { source: 'ad_wallet_withdrawal' } }),
      prisma.wallet_transaction.findMany({ where: { source: { in: ['ad_wallet_topup', 'ad_wallet_withdrawal', 'ad_campaign'] } }, orderBy: { transaction_id: 'desc' }, take: 40, select: { transaction_id: true, user_id: true, amount: true, type: true, source: true, description: true, created_at: true } }),
    ]);

    const users = await userSummaries([...rows.map((r) => r.user_id), ...ledger.map((l) => l.user_id)]);
    res.json({
      summary: {
        count, balance: num(sum._sum.balance),
        topups: { count: num(topups._count?._all), amount: num(topups._sum?.amount) },
        withdrawals: { count: num(withdrawals._count?._all), amount: num(withdrawals._sum?.amount) },
      },
      byStatus: byStatus.map((s) => ({ name: s.status, count: num(s._count._all), balance: num(s._sum.balance) })).sort((a, b) => b.count - a.count),
      pagination: { page, limit, pages: Math.ceil(count / limit) },
      wallets: rows.map((w) => ({ ads_wallet_id: w.ads_wallet_id, balance: num(w.balance), currency: w.currency, status: w.status, updated_at: w.updated_at, owner: users[w.user_id] || null })),
      ledger: ledger.map((l) => ({ transaction_id: l.transaction_id, amount: num(l.amount), type: l.type, source: l.source, description: l.description, created_at: l.created_at, owner: users[l.user_id] || null })),
      note: 'Ads wallets = the advertiser ad-spend balances. Top-ups / withdrawals move value between the core wallet and the ads wallet (wallet_transaction source ad_wallet_topup / ad_wallet_withdrawal); ad_campaign rows are spend debits.',
    });
  } catch (err) {
    console.error('[board-admin/marketing] /wallets failed:', err);
    res.status(500).json({ error: 'Failed to load ads wallets' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────
// GET /moderation — campaign review queue + flagged + reported.  ?mode=queue|flagged|rejected
// ─────────────────────────────────────────────────────────────────────────────────────
router.get('/moderation', async (req, res) => {
  try {
    const mode = ['queue', 'flagged', 'rejected'].includes(req.query.mode) ? req.query.mode : 'queue';
    const page = clampInt(req.query.page, 1, 100000, 1);
    const limit = clampInt(req.query.limit, 1, 100, 25);

    const where = mode === 'queue' ? { status: 'PENDING_REVIEW' }
      : mode === 'rejected' ? { status: 'REJECTED' }
        : { OR: [{ is_sensitive: true }, { safety_score: { lt: 1 } }] };

    const [pendingReview, flagged, rejected, reportedAds, total, rows] = await Promise.all([
      prisma.ads_campaign.count({ where: { status: 'PENDING_REVIEW' } }),
      prisma.ads_campaign.count({ where: { OR: [{ is_sensitive: true }, { safety_score: { lt: 1 } }] } }),
      prisma.ads_campaign.count({ where: { status: 'REJECTED' } }),
      prisma.social_report.count({ where: { target_type: 'AD' } }),
      prisma.ads_campaign.count({ where }),
      prisma.ads_campaign.findMany({
        where, orderBy: { created_at: 'desc' }, skip: (page - 1) * limit, take: limit,
        select: { campaign_id: true, ads_wallet_id: true, title: true, ad_type: true, vertical: true, main_category: true, status: true, is_sensitive: true, safety_score: true, created_at: true },
      }),
    ]);

    const owners = await walletOwners(rows.map((r) => r.ads_wallet_id));
    res.json({
      mode,
      summary: { pendingReview, flagged, rejected, reportedAds },
      total,
      pagination: { page, limit, pages: Math.ceil(total / limit) },
      campaigns: rows.map((c) => ({
        campaign_id: c.campaign_id, title: c.title, ad_type: c.ad_type, vertical: c.vertical,
        main_category: c.main_category, status: c.status, is_sensitive: c.is_sensitive,
        safety_score: c.safety_score, created_at: c.created_at, advertiser: owners[c.ads_wallet_id] || null,
      })),
      note: 'Ad moderation = campaigns awaiting review (PENDING_REVIEW), content-safety-flagged creatives, rejected campaigns, and the count of user-reported ads (social_report target_type=AD). Approve / reject is a write in the ads-moderation admin route.',
    });
  } catch (err) {
    console.error('[board-admin/marketing] /moderation failed:', err);
    res.status(500).json({ error: 'Failed to load ad moderation' });
  }
});

export default router;
