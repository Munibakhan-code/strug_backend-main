import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../app.js';
import { db, createUser, truncateAll, closeDb } from '../helpers/db.js';
import { authHeader } from '../helpers/auth.js';

// End-to-end verification of the three on-demand provider analytics endpoints added in
// feat/ondemand-provider-analytics: driver (extended with reliability metrics), on-demand
// worker (new), and courier (new). Seeds real rows in the local test DB and asserts the
// unified panel shape + the new `metrics` array.

describe('on-demand provider analytics', () => {
  let driverUser, workerUser, courierUser;

  beforeAll(async () => {
    await truncateAll();

    // ── Driver: profile + 2 completed trips + 2 ratings ──
    driverUser = await createUser();
    const dp = await db.driver_profile.create({ data: { user_id: driverUser.user_id, rating: 4.8 } });
    const now = new Date();
    const t1 = await db.active_trip.create({ data: { driver_id: dp.driver_profile_id, total_fare: 30, driver_payout: 23.7, payment_method: 'card', actual_distance_km: 8, ended_at: now } });
    const t2 = await db.active_trip.create({ data: { driver_id: dp.driver_profile_id, total_fare: 20, driver_payout: 15.8, payment_method: 'cash', actual_distance_km: 4, ended_at: now } });
    await db.ride_rating.create({ data: { trip_id: t1.trip_id, user_id: driverUser.user_id, rating: 5 } });
    await db.ride_rating.create({ data: { trip_id: t2.trip_id, user_id: driverUser.user_id, rating: 4 } });

    // ── Worker: profile + category + 2 completed jobs (1 cancelled) + 1 review ──
    workerUser = await createUser();
    const wp = await db.worker_profile.create({ data: { user_id: workerUser.user_id, rating: 4.6 } });
    const macro = await db.work_category.create({ data: { name: 'Hospitality', slug: `hosp-${wp.worker_profile_id}` } });
    const cat = await db.work_category.create({ data: { name: 'Server', slug: `server-${wp.worker_profile_id}`, parent_id: macro.work_category_id } });
    await db.work_job.create({ data: { assigned_worker_id: wp.worker_profile_id, category_id: cat.work_category_id, status: 'completed', price_type: 'flat', hirer_set_price: 100, worker_payout: 80, tip_amount: 10, updated_at: now } });
    await db.work_job.create({ data: { assigned_worker_id: wp.worker_profile_id, category_id: cat.work_category_id, status: 'completed', price_type: 'hourly', hourly_rate: 25, duration_hours: 4, worker_payout: 92, tip_amount: 0, updated_at: now } });
    await db.work_job.create({ data: { assigned_worker_id: wp.worker_profile_id, category_id: cat.work_category_id, status: 'cancelled', updated_at: now } });
    await db.work_review.create({ data: { work_job_id: 1, worker_profile_id: wp.worker_profile_id, rating: 5, created_at: now } });

    // ── Courier: driver_profile + courier capability + 2 delivered orders (1 cancelled) ──
    courierUser = await createUser();
    const cp = await db.driver_profile.create({
      data: {
        user_id: courierUser.user_id,
        accepts_courier: true,
        driver_courier_profile: { create: { display_name: 'Test Courier' } },
      },
    });
    const pickup = new Date(now.getTime() - 30 * 60000);
    await db.courier_order.create({ data: { courier_service_provider_id: cp.driver_profile_id, status: 'delivered', price: 25, payment_method: 'card', pickup_date: pickup, deliver_date: now, last_update: now } });
    await db.courier_order.create({ data: { courier_service_provider_id: cp.driver_profile_id, status: 'delivered', price: 15, payment_method: 'wallet', deliver_date: now, last_update: now } });
    await db.courier_order.create({ data: { courier_service_provider_id: cp.driver_profile_id, status: 'cancelled', price: 10, last_update: now } });
  });

  afterAll(async () => { await truncateAll(); await closeDb(); });

  it('driver overview returns earnings + reliability metrics', async () => {
    const res = await request(app).get('/driver-profile/analytics/overview?range=28d').set(authHeader(driverUser));
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.currency).toBe('CAD');
    expect(d.summary.gross).toBe(50);        // 30 + 20
    expect(d.summary.net).toBeCloseTo(39.5); // 23.7 + 15.8
    expect(d.summary.count).toBe(2);
    expect(Array.isArray(d.metrics)).toBe(true);
    const byKey = Object.fromEntries(d.metrics.map(m => [m.key, m]));
    expect(byKey.lifetime_rating.value).toBe(4.8);
    expect(byKey.recent_rating.value).toBe(4.5);   // (5 + 4) / 2
    expect(byKey.five_star_pct.value).toBe(50);     // 1 of 2
    expect(byKey.avg_distance.value).toBe(6);       // (8 + 4) / 2
  });

  it('worker overview returns earnings + reliability metrics', async () => {
    const res = await request(app).get('/workers/me/analytics/overview?range=28d').set(authHeader(workerUser));
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.summary.gross).toBe(200);   // 100 + (25*4)
    expect(d.summary.net).toBe(182);     // (80+10) + (92+0)
    expect(d.summary.count).toBe(2);
    expect(d.breakdown[0].label).toBe('Server');
    expect(d.top[0].title).toBe('Server');
    const byKey = Object.fromEntries(d.metrics.map(m => [m.key, m]));
    expect(byKey.completion_rate.value).toBeCloseTo(66.67, 1); // 2 of 3 finished
    expect(byKey.cancellations.value).toBe(1);
    expect(byKey.lifetime_rating.value).toBe(4.6);
    expect(byKey.recent_rating.value).toBe(5);
    expect(byKey.tips.value).toBe(10);
  });

  it('courier overview returns earnings + reliability metrics', async () => {
    const res = await request(app).get('/courier-order/analytics/overview?range=28d').set(authHeader(courierUser));
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.summary.gross).toBe(40);            // 25 + 15
    expect(d.summary.net).toBeCloseTo(31.6);     // (25+15) * 0.79
    expect(d.summary.count).toBe(2);
    const byKey = Object.fromEntries(d.metrics.map(m => [m.key, m]));
    expect(byKey.completion_rate.value).toBeCloseTo(66.67, 1); // 2 delivered of 3 finished
    expect(byKey.cancellations.value).toBe(1);
    expect(byKey.avg_delivery_time.value).toBe(30);            // 30 min on the one with both timestamps
  });

  it('all three 401 without a token', async () => {
    for (const url of ['/driver-profile/analytics/overview', '/workers/me/analytics/overview', '/courier-order/analytics/overview']) {
      const res = await request(app).get(url);
      expect(res.status).toBe(401);
    }
  });
});
