import { describe, it, expect } from 'vitest';
import {
  computeCustomerSegments,
  classifyCustomerAgainstVendorOrders,
  customerMatchesAudienceSegment,
  normalizeAudienceSegment,
} from '../../utils/customer-analytics.js';

const NOW = new Date('2026-07-06T00:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000);

describe('computeCustomerSegments', () => {
  it('returns an all-zero shape for no orders', () => {
    const r = computeCustomerSegments([], { now: NOW });
    expect(r.total_customers).toBe(0);
    expect(r.repeat_rate_pct).toBe(0);
    expect(r.avg_ltv).toBe(0);
    expect(r.vip_customers).toBe(0);
  });

  it('classifies new / returning / one-and-done', () => {
    const orders = [
      // customer A: 2 orders, both recent -> returning + active
      { customer_id: 'A', at: daysAgo(3), amount: 50 },
      { customer_id: 'A', at: daysAgo(1), amount: 70 },
      // customer B: 1 order, recent -> new + one-and-done + active
      { customer_id: 'B', at: daysAgo(5), amount: 20 },
    ];
    const r = computeCustomerSegments(orders, { now: NOW });
    expect(r.total_customers).toBe(2);
    expect(r.returning_customers).toBe(1);
    expect(r.one_and_done).toBe(1);
    expect(r.new_customers).toBe(2); // both first-ordered within 30d
    expect(r.repeat_rate_pct).toBe(50);
    expect(r.avg_orders_per_customer).toBe(1.5);
    expect(r.avg_ltv).toBe(70); // (120 + 20) / 2
  });

  it('classifies lapsed vs churned by recency of last order', () => {
    const orders = [
      { customer_id: 'lapsed', at: daysAgo(45), amount: 10 },   // 30<45<=90 -> lapsed
      { customer_id: 'churned', at: daysAgo(200), amount: 10 }, // >90 -> churned
      { customer_id: 'active', at: daysAgo(2), amount: 10 },    // <=30 -> active
    ];
    const r = computeCustomerSegments(orders, { now: NOW });
    expect(r.lapsed_customers).toBe(1);
    expect(r.churned_customers).toBe(1);
    expect(r.active_customers).toBe(1);
    // none first-ordered within 30d except 'active'
    expect(r.new_customers).toBe(1);
  });

  it('flags top spenders as VIP (top 10%, min 1)', () => {
    const orders = [];
    for (let i = 0; i < 20; i++) orders.push({ customer_id: `c${i}`, at: daysAgo(2), amount: 10 });
    orders.push({ customer_id: 'whale', at: daysAgo(2), amount: 5000 });
    const r = computeCustomerSegments(orders, { now: NOW });
    expect(r.total_customers).toBe(21);
    expect(r.vip_customers).toBeGreaterThanOrEqual(1);
    expect(r.vip_customers).toBeLessThanOrEqual(3); // ~10% of 21
  });

  it('ignores rows with null customer or bad dates', () => {
    const orders = [
      { customer_id: null, at: daysAgo(1), amount: 10 },
      { customer_id: 'X', at: 'not-a-date', amount: 10 },
      { customer_id: 'X', at: daysAgo(1), amount: 10 },
    ];
    const r = computeCustomerSegments(orders, { now: NOW });
    expect(r.total_customers).toBe(1);
  });

  it('reports recent buyers and aggregate non-buyer opportunities', () => {
    const r = computeCustomerSegments(
      [
        { customer_id: 'recent', at: daysAgo(3), amount: 10 },
        { customer_id: 'old', at: daysAgo(120), amount: 10 },
      ],
      { now: NOW, audienceSize: 7 },
    );
    expect(r.recent_buyers).toBe(1);
    expect(r.non_buyers).toBe(5);
    expect(r.reachable_audience).toBe(7);
  });
});

describe('classifyCustomerAgainstVendorOrders + audience match', () => {
  it('normalizes opportunity segment aliases', () => {
    expect(normalizeAudienceSegment('first_order')).toBe('prospects');
    expect(normalizeAudienceSegment('recent_buyers')).toBe('recent');
    expect(normalizeAudienceSegment('vip')).toBe('vip');
  });

  it('marks never-ordered users as prospects only', () => {
    const flags = classifyCustomerAgainstVendorOrders(99, [
      { customer_id: 1, at: daysAgo(2), amount: 20 },
    ], { now: NOW });
    expect(flags.prospects).toBe(true);
    expect(flags.recent).toBe(false);
    expect(customerMatchesAudienceSegment(flags, 'prospects')).toBe(true);
    expect(customerMatchesAudienceSegment(flags, 'vip')).toBe(false);
  });

  it('matches recent and vip against vendor history', () => {
    const orders = [];
    for (let i = 0; i < 20; i++) orders.push({ customer_id: i + 1, at: daysAgo(2), amount: 10 });
    orders.push({ customer_id: 100, at: daysAgo(2), amount: 5000 });
    const flags = classifyCustomerAgainstVendorOrders(100, orders, { now: NOW });
    expect(flags.prospects).toBe(false);
    expect(flags.recent).toBe(true);
    expect(flags.vip).toBe(true);
    expect(customerMatchesAudienceSegment(flags, 'recent')).toBe(true);
    expect(customerMatchesAudienceSegment(flags, 'vip')).toBe(true);
  });
});
