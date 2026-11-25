/**
 * Server-side composition for Data & Analytics executive overview (Phase 0).
 * Replaces the FE N-way fan-out of users/finance/ops/content with one cached payload.
 */

import {
  ANALYTICS_METRICS,
  clampAnalyticsDays,
  resolveAnalyticsWindows,
  withDelta,
} from '../utils/analytics-metrics.js';

const num = (d) => (d == null ? 0 : Number(d));

/** @type {Map<string, { expires: number, payload: object }>} */
const cache = new Map();
const CACHE_TTL_MS = 45_000;

export function clearAnalyticsOverviewCache() {
  cache.clear();
}

/**
 * Paid GMV aggregates for a single [start, end) window.
 * Mirrors board-admin/finance /revenue paid flags (subset used by executive KPIs).
 */
async function gmvForWindow(prisma, start, end) {
  const whereTs = (field) => ({ [field]: { gte: start, lt: end } });
  const [
    food, product, digital, rental, service, courier, donation, subs, adRev,
  ] = await Promise.all([
    prisma.food_order.aggregate({
      _sum: { total_amount: true },
      _count: true,
      where: { ispaid: true, ...whereTs('created_at') },
    }),
    prisma.product_order.aggregate({
      _sum: { total: true },
      _count: true,
      where: { ispaid: true, ...whereTs('order_time') },
    }),
    prisma.dg_order.aggregate({
      _sum: { total: true },
      _count: true,
      where: { ispaid: true, ...whereTs('date') },
    }),
    prisma.rental_order.aggregate({
      _sum: { total: true },
      _count: true,
      where: { ispaid: true, ...whereTs('date') },
    }),
    prisma.service_order.aggregate({
      _sum: { total: true },
      _count: true,
      where: { ispaid: true, ...whereTs('created_at') },
    }),
    prisma.courier_order.aggregate({
      _sum: { price: true },
      _count: true,
      where: { is_paid: true, ...whereTs('payment_time') },
    }),
    prisma.donations.aggregate({
      _sum: { amount: true },
      _count: true,
      where: { payment_status: 'paid', ...whereTs('donated_date') },
    }),
    prisma.wallet_transaction.aggregate({
      _sum: { amount: true },
      _count: true,
      where: { source: 'live_subscription', type: 'credit', ...whereTs('created_at') },
    }),
    prisma.revenue_share_log.aggregate({
      _sum: { total_earned: true },
      _count: true,
      where: whereTs('created_at'),
    }),
  ]);

  const byVertical = [
    { vertical: 'Food', gross: num(food._sum.total_amount), orders: food._count },
    { vertical: 'Products', gross: num(product._sum.total), orders: product._count },
    { vertical: 'Digital goods', gross: num(digital._sum.total), orders: digital._count },
    { vertical: 'Rentals', gross: num(rental._sum.total), orders: rental._count },
    { vertical: 'Services', gross: num(service._sum.total), orders: service._count },
    { vertical: 'Courier', gross: num(courier._sum.price), orders: courier._count },
    { vertical: 'Donations', gross: num(donation._sum.amount), orders: donation._count },
    { vertical: 'Live subscriptions', gross: num(subs._sum.amount), orders: subs._count },
    { vertical: 'Video ads', gross: num(adRev._sum.total_earned), orders: adRev._count },
  ].sort((a, b) => b.gross - a.gross);

  const totalGMV = byVertical.reduce((s, v) => s + v.gross, 0);
  const totalOrders = byVertical.reduce((s, v) => s + (v.orders || 0), 0);
  return {
    totalGMV,
    totalOrders,
    aov: totalOrders ? totalGMV / totalOrders : 0,
    byVertical,
  };
}

async function signupCount(prisma, start, end) {
  return prisma.social_profile.count({
    where: { created_at: { gte: start, lt: end } },
  });
}

/**
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{ days?: unknown, now?: Date, bypassCache?: boolean }} [opts]
 */
export async function buildAnalyticsOverview(prisma, opts = {}) {
  const days = clampAnalyticsDays(opts.days);
  const now = opts.now || new Date();
  const cacheKey = `overview:${days}`;
  if (!opts.bypassCache) {
    const hit = cache.get(cacheKey);
    if (hit && hit.expires > Date.now()) return hit.payload;
  }

  const { start, end, priorStart, priorEnd } = resolveAnalyticsWindows(days, now);
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const [
    totalUsers,
    sellers,
    creators,
    verified,
    signupsCurrent,
    signupsPrior,
    registrations,
    gmvCurrent,
    gmvPrior,
    walletSum,
    fundedWallets,
    negativeWallets,
    payoutPending,
    liveTrips,
    onlineProviders,
    openVendors,
    activeDrivers,
    videos,
    channels,
    totalViewsAgg,
    recentViews,
    byProcessingRaw,
    dailyGmv,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { is_seller: true } }),
    prisma.user.count({ where: { is_creator: true } }),
    prisma.user.count({ where: { social_profiles: { is_verified: true } } }),
    signupCount(prisma, start, end),
    signupCount(prisma, priorStart, priorEnd),
    prisma.$queryRaw`
      SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS date, COUNT(*)::int AS count
      FROM social_profile
      WHERE created_at >= ${start} AND created_at < ${end}
      GROUP BY 1 ORDER BY 1 ASC`,
    gmvForWindow(prisma, start, end),
    gmvForWindow(prisma, priorStart, priorEnd),
    prisma.strug_wallet.aggregate({ _sum: { balance: true } }),
    prisma.strug_wallet.count({ where: { balance: { gt: 0 } } }),
    prisma.strug_wallet.count({ where: { balance: { lt: 0 } } }),
    prisma.live_payout_request.aggregate({
      _sum: { amount: true },
      _count: true,
      where: { status: 'PENDING' },
    }),
    prisma.active_trip.count({ where: { ended_at: null } }),
    prisma.user_service_provider.count({ where: { is_online: true } }),
    prisma.food_vendor.count({ where: { is_open: true } }),
    prisma.driver_profile.count({ where: { is_online: true } }),
    prisma.video.count(),
    prisma.channel.count(),
    prisma.video.aggregate({ _sum: { views_count: true } }),
    prisma.video_view.count({ where: { viewed_at: { gte: start, lt: end } } }),
    prisma.video.groupBy({ by: ['processing_status'], _count: { _all: true } }),
    prisma.$queryRaw`
      SELECT to_char(date_trunc('day', d), 'YYYY-MM-DD') AS date,
             SUM(amount)::float AS gross,
             COUNT(*)::int AS orders
      FROM (
        SELECT created_at::timestamp AS d, total_amount AS amount FROM food_order
          WHERE ispaid = true AND created_at >= ${start} AND created_at < ${end}
        UNION ALL
        SELECT order_time::timestamp, total FROM product_order
          WHERE ispaid = true AND order_time >= ${start} AND order_time < ${end}
        UNION ALL
        SELECT date::timestamp, total FROM dg_order
          WHERE ispaid = true AND date >= ${start} AND date < ${end}
        UNION ALL
        SELECT date::timestamp, total FROM rental_order
          WHERE ispaid = true AND date >= ${start} AND date < ${end}
        UNION ALL
        SELECT created_at::timestamp, total FROM service_order
          WHERE ispaid = true AND created_at >= ${start} AND created_at < ${end}
        UNION ALL
        SELECT payment_time::timestamp, price FROM courier_order
          WHERE is_paid = true AND payment_time >= ${start} AND payment_time < ${end}
        UNION ALL
        SELECT donated_date::timestamp, amount FROM donations
          WHERE payment_status = 'paid' AND donated_date >= ${start} AND donated_date < ${end}
        UNION ALL
        SELECT created_at::timestamp, amount FROM wallet_transaction
          WHERE source = 'live_subscription' AND type = 'credit'
            AND created_at >= ${start} AND created_at < ${end}
        UNION ALL
        SELECT created_at::timestamp, total_earned FROM revenue_share_log
          WHERE created_at >= ${start} AND created_at < ${end}
      ) t
      WHERE d IS NOT NULL
      GROUP BY 1 ORDER BY 1`,
  ]);

  // Ops "today" / active are approximate without the full ops union; use live signals.
  const ordersTodayRows = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS c FROM (
      SELECT created_at FROM food_order WHERE created_at >= ${todayStart}
      UNION ALL SELECT order_time FROM product_order WHERE order_time >= ${todayStart}
      UNION ALL SELECT created_at FROM service_order WHERE created_at >= ${todayStart}
      UNION ALL SELECT payment_time FROM courier_order WHERE payment_time >= ${todayStart}
    ) u`;
  const ordersTodayApprox = num(ordersTodayRows?.[0]?.c);

  const processingQueued = (byProcessingRaw || [])
    .filter((p) => /pending|processing|queued/i.test(String(p.processing_status || '')))
    .reduce((a, b) => a + num(b._count?._all), 0);
  const processingFailed = (byProcessingRaw || [])
    .filter((p) => /error|fail/i.test(String(p.processing_status || '')))
    .reduce((a, b) => a + num(b._count?._all), 0);

  const kpis = {
    total_users: withDelta(totalUsers, totalUsers), // stock metric; no prior stock in Phase 0
    signups_window: withDelta(signupsCurrent, signupsPrior),
    gmv_window: withDelta(gmvCurrent.totalGMV, gmvPrior.totalGMV),
    orders_window: withDelta(gmvCurrent.totalOrders, gmvPrior.totalOrders),
    aov_window: withDelta(gmvCurrent.aov, gmvPrior.aov),
    wallet_float: withDelta(num(walletSum._sum.balance), num(walletSum._sum.balance)),
    orders_today: withDelta(ordersTodayApprox, ordersTodayApprox),
    online_providers: withDelta(onlineProviders, onlineProviders),
    content_views_total: withDelta(num(totalViewsAgg._sum.views_count), num(totalViewsAgg._sum.views_count)),
    content_videos: withDelta(videos, videos),
  };

  const payload = {
    days,
    window: {
      start: start.toISOString(),
      end: end.toISOString(),
      priorStart: priorStart.toISOString(),
      priorEnd: priorEnd.toISOString(),
    },
    generatedAt: now.toISOString(),
    cacheTtlSec: Math.round(CACHE_TTL_MS / 1000),
    kpis,
    audience: {
      totalUsers,
      sellers,
      creators,
      verified,
      signupsWindow: signupsCurrent,
      registrations,
    },
    commerce: {
      totalGMV: gmvCurrent.totalGMV,
      totalOrders: gmvCurrent.totalOrders,
      aov: gmvCurrent.aov,
      byVertical: gmvCurrent.byVertical,
      daily: dailyGmv,
      prior: {
        totalGMV: gmvPrior.totalGMV,
        totalOrders: gmvPrior.totalOrders,
        aov: gmvPrior.aov,
      },
    },
    finance: {
      wallets: {
        totalBalance: num(walletSum._sum.balance),
        funded: fundedWallets,
        negative: negativeWallets,
      },
      payoutQueue: {
        count: payoutPending._count,
        amount: num(payoutPending._sum.amount),
      },
    },
    marketplace: {
      liveTrips,
      onlineProviders,
      openVendors,
      activeDrivers,
      ordersToday: ordersTodayApprox,
    },
    content: {
      videos,
      channels,
      totalViews: num(totalViewsAgg._sum.views_count),
      recentViews,
      processingQueued,
      processingFailed,
    },
    drilldowns: Object.fromEntries(
      ANALYTICS_METRICS.map((m) => [m.id, m.drill]),
    ),
    note: 'Phase 0 server-composed executive overview. Windowed KPIs include prior-period deltas. Stock metrics (users, float, live supply) do not invent a prior stock.',
  };

  cache.set(cacheKey, { expires: Date.now() + CACHE_TTL_MS, payload });
  return payload;
}

export function buildMetricsCatalog() {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    metrics: ANALYTICS_METRICS.map((m) => ({ ...m })),
    note: 'Single source of truth for Data & Analytics KPI definitions (Phase 0).',
  };
}
