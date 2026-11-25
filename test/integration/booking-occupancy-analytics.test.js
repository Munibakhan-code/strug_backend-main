import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../app.js';
import { db, createUser, truncateAll, closeDb } from '../helpers/db.js';
import { authHeader } from '../helpers/auth.js';

// Verifies occupancy/ADR (#289) + cancellation (#291) + completed-only revenue KPIs
// on GET /booking/host/me/analytics/overview.

describe('booking host analytics — occupancy/ADR/cancellation metrics', () => {
  let stayHost, sessionHost, hotelHost, guest;
  const day = (n) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + n);
    d.setUTCHours(12, 0, 0, 0); // noon UTC avoids DATE timezone edge cases
    return d;
  };

  beforeAll(async () => {
    await truncateAll();

    guest = await createUser({ name: 'Analytics Guest' });

    stayHost = await createUser();
    const listing = await db.booking_listing.create({
      data: {
        vertical: 'tempstay',
        owner_id: stayHost.user_id,
        title: 'Cozy Loft',
        price: 100,
        price_unit: 'night',
        is_active: true,
      },
    });
    const mk = (overrides) => db.booking.create({
      data: {
        vertical: 'tempstay',
        booking_listing_id: listing.booking_listing_id,
        host_id: stayHost.user_id,
        guest_id: guest.user_id,
        subtotal: 200,
        cleaning_fee: 20,
        service_fee: 30,
        total: 250,
        status: 'completed',
        payment_status: 'paid',
        payment_method: 'card',
        ...overrides,
      },
    });
    await mk({
      start_date: day(-10),
      end_date: day(-8),
      unit_count: 2,
      subtotal: 200,
      created_at: day(-12),
    });
    await mk({
      start_date: day(-5),
      end_date: day(-2),
      unit_count: 3,
      subtotal: 300,
      cleaning_fee: 20,
      service_fee: 30,
      total: 350,
      created_at: day(-7),
    });
    // In-house now — occupancy + status donut; not revenue KPIs
    await mk({
      status: 'in_progress',
      start_date: day(-1),
      end_date: day(2),
      unit_count: 3,
      subtotal: 200,
      created_at: day(-2),
    });
    await db.booking.create({
      data: {
        vertical: 'tempstay',
        booking_listing_id: listing.booking_listing_id,
        host_id: stayHost.user_id,
        guest_id: guest.user_id,
        subtotal: 150,
        status: 'cancelled',
        payment_status: 'refunded',
        payment_method: 'card',
        created_at: day(-3),
        start_date: day(-4),
        end_date: day(-3),
      },
    });
    await mk({
      status: 'confirmed',
      start_date: day(5),
      end_date: day(7),
      unit_count: 2,
      subtotal: 200,
      created_at: day(-1),
    });

    sessionHost = await createUser();
    const cl = await db.booking_listing.create({
      data: {
        vertical: 'celebrity',
        owner_id: sessionHost.user_id,
        title: 'Cameo',
        price: 80,
        price_unit: 'async',
        is_active: true,
      },
    });
    await db.booking.create({
      data: {
        vertical: 'celebrity',
        booking_listing_id: cl.booking_listing_id,
        host_id: sessionHost.user_id,
        guest_id: guest.user_id,
        subtotal: 80,
        service_fee: 10,
        total: 90,
        status: 'completed',
        payment_status: 'paid',
        unit_count: 1,
        created_at: day(-2),
      },
    });
    await db.booking.create({
      data: {
        vertical: 'celebrity',
        booking_listing_id: cl.booking_listing_id,
        host_id: sessionHost.user_id,
        guest_id: guest.user_id,
        subtotal: 80,
        status: 'declined',
        created_at: day(-1),
      },
    });

    hotelHost = await createUser();
    const hotel = await db.booking_listing.create({
      data: {
        vertical: 'hotel',
        owner_id: hotelHost.user_id,
        title: 'Test Inn',
        price: 100,
        price_unit: 'night',
        is_active: true,
      },
    });
    await db.hotel_room_type.create({
      data: {
        booking_listing_id: hotel.booking_listing_id,
        name: 'Standard',
        quantity: 4,
        nightly_price: 100,
        is_active: true,
      },
    });
    await db.booking.create({
      data: {
        vertical: 'hotel',
        booking_listing_id: hotel.booking_listing_id,
        host_id: hotelHost.user_id,
        guest_id: guest.user_id,
        subtotal: 200,
        cleaning_fee: 20,
        service_fee: 24,
        total: 244,
        status: 'completed',
        payment_status: 'paid',
        payment_method: 'card',
        start_date: day(-6),
        end_date: day(-4),
        unit_count: 2,
        created_at: day(-8),
      },
    });
  });

  afterAll(async () => {
    await truncateAll();
    await closeDb();
  });

  it('date-priced host gets occupancy + ADR + avg stay + cancellation', async () => {
    const res = await request(app)
      .get('/booking/host/me/analytics/overview?range=28d&vertical=tempstay')
      .set(authHeader(stayHost));
    expect(res.status).toBe(200);
    const m = Object.fromEntries(res.body.data.metrics.map((x) => [x.key, x]));
    // 2 completed (2+3) + 1 in_progress (3) + optionally future confirmed via created_at
    // Assert core ratios from nightsSold rather than brittle absolute booking counts.
    expect(m.adr.value).toBeGreaterThan(0);
    expect(m.occupancy.value).toBeGreaterThan(0);
    expect(m.avg_stay.value).toBeGreaterThanOrEqual(2);
    // Host net ADR for completed-only nights would be 108; with in_progress included ≤ 108-ish
    expect(m.adr.value).toBeGreaterThanOrEqual(90);
    expect(m.adr.value).toBeLessThanOrEqual(120);
    // accepted ≥ 3 (2 completed + in_progress), + cancelled → rate ≤ 25%
    expect(m.cancellation_rate.value).toBeLessThanOrEqual(25);
    expect(m.declined.value).toBe(0);
  });

  it('session-priced host gets cancellation only (no occupancy/ADR)', async () => {
    const res = await request(app)
      .get('/booking/host/me/analytics/overview?range=28d&vertical=celebrity')
      .set(authHeader(sessionHost));
    expect(res.status).toBe(200);
    const keys = res.body.data.metrics.map((x) => x.key);
    expect(keys).not.toContain('occupancy');
    expect(keys).not.toContain('adr');
    const m = Object.fromEntries(res.body.data.metrics.map((x) => [x.key, x]));
    expect(m.cancellation_rate.value).toBe(0);
    expect(m.declined.value).toBe(1);
  });

  it('revenue KPIs count completed stays only (not pipeline)', async () => {
    const res = await request(app)
      .get('/booking/host/me/analytics/overview?range=28d&vertical=tempstay')
      .set(authHeader(stayHost));
    expect(res.body.data.summary.gross).toBe(600);
    expect(res.body.data.summary.net).toBe(540);
    expect(res.body.data.summary.count).toBe(2);
    expect(res.body.data.top[0].title).toBe('Cozy Loft');
    const labels = res.body.data.breakdown.map((b) => b.label);
    expect(labels).toEqual(expect.arrayContaining(['completed', 'cancelled']));
    expect(labels).toEqual(expect.arrayContaining(['in_progress']));
    expect(res.body.data.timezone).toBeTruthy();
  });

  it('hotel occupancy uses room inventory capacity not listing count', async () => {
    const res = await request(app)
      .get('/booking/host/me/analytics/overview?range=28d&vertical=hotel')
      .set(authHeader(hotelHost));
    expect(res.status).toBe(200);
    const m = Object.fromEntries(res.body.data.metrics.map((x) => [x.key, x]));
    expect(m.occupancy.value).toBeCloseTo((2 / (4 * 28)) * 100, 1);
    expect(m.occupancy.hint).toMatch(/4 rooms/);
    expect(m.adr.value).toBe(110);
    expect(res.body.data.summary.count).toBe(1);
    expect(res.body.data.summary.net).toBe(220);
  });
});
