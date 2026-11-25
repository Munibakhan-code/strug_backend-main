import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../app.js';
import { db, createUser, truncateAll, closeDb } from '../helpers/db.js';

/** Phase 9 — hybrid shipping quote API smoke on real DB rows. */
describe('shop shipping quote (Phase 9)', () => {
  let seller;
  let storeId;

  beforeAll(async () => {
    await truncateAll();
    seller = await createUser({ name: 'Zone Seller' });
    const store = await db.store_profile.create({
      data: {
        user_id: seller.user_id,
        store_name: 'Zone Seller',
        lat: 43.6532,
        lng: -79.3832,
        is_active: true,
        is_open: true,
      },
    });
    storeId = store.store_id;
    await db.store_shipping_zone.create({
      data: {
        store_id: storeId,
        name: 'Pakistan',
        match_type: 'country',
        country: 'Pakistan',
        city: null,
        fee: 22,
        priority: 10,
        is_active: true,
      },
    });
  });

  afterAll(async () => {
    await truncateAll();
    await closeDb();
  });

  it('quotes local delivery for buyers inside radius', async () => {
    const res = await request(app).post('/shipping/quote').send({
      seller_id: seller.user_id,
      country: 'Canada',
      city: 'Toronto',
      lat: 43.66,
      lng: -79.39,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, local: true, mode: 'delivery' });
    expect(res.body.fee).toBeGreaterThan(0);
  });

  it('quotes ship_by_seller zone fee for remote buyers', async () => {
    const res = await request(app).post('/shipping/quote').send({
      seller_id: seller.user_id,
      country: 'Pakistan',
      city: 'Lahore',
      lat: 31.52,
      lng: 74.35,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      local: false,
      mode: 'ship_by_seller',
      fee: 22,
    });
  });

  it('returns 422 when remote buyer has no matching zone', async () => {
    const res = await request(app).post('/shipping/quote').send({
      seller_id: seller.user_id,
      country: 'China',
      city: 'Beijing',
      lat: 39.9,
      lng: 116.4,
    });
    expect(res.status).toBe(422);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/does not ship/i);
  });
});
