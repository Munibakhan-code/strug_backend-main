import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/prisma-client.js', () => ({ default: {} }));

import {
  buildAnalyticsOverview,
  buildMetricsCatalog,
  clearAnalyticsOverviewCache,
} from '../../services/board-analytics-overview.js';

function agg(sumFields = {}, count = 0) {
  return { _sum: sumFields, _count: count };
}

function makePrisma() {
  const prisma = {
    user: {
      count: vi.fn(async (args) => {
        if (args?.where?.is_seller) return 9;
        if (args?.where?.is_creator) return 5;
        if (args?.where?.social_profiles) return 3;
        return 100;
      }),
    },
    social_profile: {
      count: vi.fn(async () => 12),
    },
    food_order: { aggregate: vi.fn(async () => agg({ total_amount: 200 }, 2)) },
    product_order: { aggregate: vi.fn(async () => agg({ total: 50 }, 1)) },
    dg_order: { aggregate: vi.fn(async () => agg({ total: 0 }, 0)) },
    rental_order: { aggregate: vi.fn(async () => agg({ total: 0 }, 0)) },
    service_order: { aggregate: vi.fn(async () => agg({ total: 0 }, 0)) },
    courier_order: { aggregate: vi.fn(async () => agg({ price: 0 }, 0)) },
    donations: { aggregate: vi.fn(async () => agg({ amount: 0 }, 0)) },
    wallet_transaction: { aggregate: vi.fn(async () => agg({ amount: 0 }, 0)) },
    revenue_share_log: { aggregate: vi.fn(async () => agg({ total_earned: 0 }, 0)) },
    strug_wallet: {
      aggregate: vi.fn(async () => ({ _sum: { balance: 1000 } })),
      count: vi.fn(async (args) => (args?.where?.balance?.lt != null ? 1 : 4)),
    },
    live_payout_request: {
      aggregate: vi.fn(async () => ({ _sum: { amount: 25 }, _count: 2 })),
    },
    active_trip: { count: vi.fn(async () => 3) },
    user_service_provider: { count: vi.fn(async () => 7) },
    food_vendor: { count: vi.fn(async () => 2) },
    driver_profile: { count: vi.fn(async () => 4) },
    video: {
      count: vi.fn(async () => 40),
      aggregate: vi.fn(async () => ({ _sum: { views_count: 900 } })),
      groupBy: vi.fn(async () => [
        { processing_status: 'ready', _count: { _all: 38 } },
        { processing_status: 'processing', _count: { _all: 2 } },
      ]),
    },
    channel: { count: vi.fn(async () => 11) },
    video_view: { count: vi.fn(async () => 55) },
    $queryRaw: vi.fn(async (strings) => {
      const sql = String(strings?.[0] || '');
      if (sql.includes('social_profile')) return [{ date: '2026-09-01', count: 2 }];
      if (sql.includes('UNION ALL') && sql.includes('COUNT(*)')) return [{ c: 6 }];
      if (sql.includes('gross')) return [{ date: '2026-09-01', gross: 250, orders: 3 }];
      return [];
    }),
  };
  return prisma;
}

describe('buildMetricsCatalog', () => {
  it('returns versioned metric definitions', () => {
    const catalog = buildMetricsCatalog();
    expect(catalog.version).toBe(1);
    expect(catalog.metrics.some((m) => m.id === 'gmv_window')).toBe(true);
  });
});

describe('buildAnalyticsOverview', () => {
  beforeEach(() => {
    clearAnalyticsOverviewCache();
  });

  it('composes KPIs with prior-period deltas and drilldowns', async () => {
    const prisma = makePrisma();
    const now = new Date('2026-09-23T15:00:00.000Z');
    const payload = await buildAnalyticsOverview(prisma, { days: 30, now, bypassCache: true });

    expect(payload.days).toBe(30);
    expect(payload.audience.totalUsers).toBe(100);
    expect(payload.commerce.totalGMV).toBe(250);
    expect(payload.commerce.totalOrders).toBe(3);
    expect(payload.kpis.gmv_window.value).toBe(250);
    expect(payload.kpis.signups_window.value).toBe(12);
    expect(payload.kpis.signups_window).toHaveProperty('deltaPct');
    expect(payload.drilldowns.gmv_window.dashboard).toBe('finance');
    expect(payload.content.processingQueued).toBe(2);
    expect(payload.finance.wallets.negative).toBe(1);
  });

  it('rejects empty days via clamp default and serves from cache on second hit', async () => {
    const prisma = makePrisma();
    const first = await buildAnalyticsOverview(prisma, { days: 'nope', now: new Date('2026-09-23T15:00:00.000Z') });
    expect(first.days).toBe(30);
    const calls = prisma.user.count.mock.calls.length;
    const second = await buildAnalyticsOverview(prisma, { days: 30, now: new Date('2026-09-23T15:00:00.000Z') });
    expect(second.audience.totalUsers).toBe(100);
    expect(prisma.user.count.mock.calls.length).toBe(calls);
  });

  it('treats missing aggregates as zero rather than NaN', async () => {
    const prisma = makePrisma();
    prisma.food_order.aggregate.mockResolvedValue({ _sum: { total_amount: null }, _count: 0 });
    prisma.product_order.aggregate.mockResolvedValue({ _sum: { total: null }, _count: 0 });
    const payload = await buildAnalyticsOverview(prisma, {
      days: 7,
      now: new Date('2026-09-23T15:00:00.000Z'),
      bypassCache: true,
    });
    expect(payload.commerce.totalGMV).toBe(0);
    expect(payload.commerce.aov).toBe(0);
    expect(Number.isNaN(payload.commerce.aov)).toBe(false);
  });
});
