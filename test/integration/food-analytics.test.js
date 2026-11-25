import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../app.js';
import { db, createUser, truncateAll, closeDb } from '../helpers/db.js';
import { authHeader } from '../helpers/auth.js';

// Verifies the food/grocery vendor analytics overview endpoint's new `metrics` grid
// (completion rate, avg fulfilment time, new/returning customer segmentation,
// cancellations) added for board #285/#286/#293/#294. Seeds real rows in the local
// test DB and asserts the unified panel shape + the new metrics.

describe('food vendor analytics', () => {
  let ownerUser, custA, custB;

  beforeAll(async () => {
    await truncateAll();
    ownerUser = await createUser();
    custA = await createUser();
    custB = await createUser();

    const vendor = await db.food_vendor.create({ data: { owner_id: ownerUser.user_id, vendor_name: 'Test Kitchen', is_active: true } });
    const vid = vendor.vendor_id;

    const now = new Date();
    const t = (minsFromNow) => new Date(now.getTime() + minsFromNow * 60000);
    const daysAgo = (d) => new Date(now.getTime() - d * 86400000);

    // Prior paid+delivered order from custA, well before the 28d window → makes custA "returning".
    await db.food_order.create({ data: { vendor_id: vid, user_id: custA.user_id, order_status: 'delivered', total_amount: 40, platform_fee: 3.2, ispaid: true, created_at: daysAgo(40), delivered_at: daysAgo(40) } });

    // In-range orders:
    const o1 = await db.food_order.create({ data: { vendor_id: vid, user_id: custA.user_id, order_status: 'delivered', total_amount: 30, platform_fee: 2.4, ispaid: true, created_at: now, delivered_at: t(30) } });
    await db.food_order.create({ data: { vendor_id: vid, user_id: custB.user_id, order_status: 'delivered', total_amount: 20, platform_fee: 1.6, ispaid: true, created_at: now, delivered_at: t(20) } });
    await db.food_order.create({ data: { vendor_id: vid, user_id: custB.user_id, order_status: 'cancelled', total_amount: 10, ispaid: true, created_at: now } });
    // Paid but still preparing — must NOT inflate Gross / Net / count (P0 #4).
    await db.food_order.create({ data: { vendor_id: vid, user_id: custB.user_id, order_status: 'preparing', total_amount: 99, platform_fee: 7.92, ispaid: true, created_at: now } });

    // one menu item for the "top" table
    const item = await db.food_item.create({ data: { vendor_id: vid, name: 'Signature Bowl', price: 15 } });
    await db.food_order_items.create({ data: { order_id: o1.food_order_id, food_item_id: item.food_item_id, qty: 2, price_item: 15 } });
  });

  afterAll(async () => { await truncateAll(); await closeDb(); });

  it('returns earnings + performance metrics for the owner', async () => {
    const res = await request(app).get('/food/vendor/me/analytics/overview?range=28d').set(authHeader(ownerUser));
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.currency).toBe('CAD');
    // Only fulfilled paid orders count as revenue (2 delivered). Preparing $99 + cancelled are excluded.
    expect(d.summary.count).toBe(2);
    expect(d.summary.gross).toBe(50);
    expect(d.summary.net).toBe(50); // platform_fee 2.4+1.6 at 8% → subtotal 30+20
    expect(Array.isArray(d.metrics)).toBe(true);
    const byKey = Object.fromEntries(d.metrics.map(m => [m.key, m]));
    // In-range finished: 2 delivered + 1 cancelled → round2(2/3 * 100) = 66.67
    expect(byKey.completion_rate.value).toBeCloseTo(66.67, 1);
    expect(byKey.avg_fulfilment.value).toBe(25);   // (30 + 20) / 2
    expect(byKey.returning_customers.value).toBe(50); // custA returning of {A,B}
    expect(byKey.new_customers.value).toBe(1);     // custB
    expect(byKey.cancellations.value).toBe(1);
    expect(byKey.avg_rating).toBeTruthy();
    expect(d.breakdown.find((b) => b.label === 'cancelled')?.value).toBe(1);
    expect(d.breakdown.find((b) => b.label === 'preparing')?.value).toBe(1);
    expect(d.top[0].title).toBe('Signature Bowl');
  });

  it('returns an empty (non-null) shape for a non-vendor user', async () => {
    const nobody = await createUser();
    const res = await request(app).get('/food/vendor/me/analytics/overview?range=28d').set(authHeader(nobody));
    expect(res.status).toBe(200);
    expect(res.body.data.summary.count).toBe(0);
    expect(res.body.data.metrics).toEqual([]);
  });

  it('401 without a token', async () => {
    const res = await request(app).get('/food/vendor/me/analytics/overview');
    expect(res.status).toBe(401);
  });
});
