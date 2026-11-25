import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../app.js';
import { db, createUser, truncateAll, closeDb } from '../helpers/db.js';

/** Phase 9 — public shop browse: orphan/inactive filtering + geo ranking. */
describe('shop public browse (Phase 9)', () => {
  let shopType;
  let nearbySeller;
  let farSeller;
  let noCoordSeller;
  let inactiveSeller;

  beforeAll(async () => {
    await truncateAll();
    shopType = await db.product_type.create({ data: { product_type_name: 'Shop' } });

    nearbySeller = await createUser({ name: 'Nearby Shop' });
    await db.store_profile.create({
      data: {
        user_id: nearbySeller.user_id,
        store_name: 'Nearby Shop',
        lat: 43.6532,
        lng: -79.3832,
        is_active: true,
        is_open: true,
      },
    });

    farSeller = await createUser({ name: 'Far Shop' });
    await db.store_profile.create({
      data: {
        user_id: farSeller.user_id,
        store_name: 'Far Shop',
        lat: 19.076,
        lng: 72.877,
        is_active: true,
        is_open: true,
      },
    });

    noCoordSeller = await createUser({ name: 'No Coord Shop' });
    await db.store_profile.create({
      data: {
        user_id: noCoordSeller.user_id,
        store_name: 'No Coord Shop',
        lat: null,
        lng: null,
        is_active: true,
        is_open: true,
      },
    });

    inactiveSeller = await createUser({ name: 'Closed Shop' });
    await db.store_profile.create({
      data: {
        user_id: inactiveSeller.user_id,
        store_name: 'Closed Shop',
        lat: 43.66,
        lng: -79.39,
        is_active: false,
        is_open: true,
      },
    });

    const mkListing = async (sellerId, name) => {
      const listing = await db.product_listing.create({
        data: {
          name,
          seller_id: sellerId,
          product_type_id: shopType.product_type_id,
          availability: 3,
        },
      });
      await db.product_variation.create({
        data: { listing_id: listing.listing_id, price: 25, description: 'Default' },
      });
      return listing;
    };

    await mkListing(nearbySeller.user_id, 'Nearby Widget');
    await mkListing(farSeller.user_id, 'Far Widget');
    await mkListing(noCoordSeller.user_id, 'No Coord Widget');
    await mkListing(inactiveSeller.user_id, 'Closed Widget');

    await db.product_listing.create({
      data: {
        name: 'Orphan Widget',
        seller_id: null,
        product_type_id: shopType.product_type_id,
        availability: 1,
      },
    });
  });

  afterAll(async () => {
    await truncateAll();
    await closeDb();
  });

  it('hides seller-less listings from public browse', async () => {
    const res = await request(app).get('/product-listing/').query({ public: 'true' });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((l) => l.name === 'Orphan Widget')).toBe(false);
    expect(res.body.length).toBeLessThanOrEqual(500);
  });

  it('hides listings from deactivated stores', async () => {
    const res = await request(app).get('/product-listing/').query({ public: 'true' });
    expect(res.status).toBe(200);
    expect(res.body.some((l) => l.name === 'Closed Widget')).toBe(false);
  });

  it('ranks nearby stores first but keeps sellers without coords', async () => {
    const res = await request(app)
      .get('/product-listing/')
      .query({ public: 'true', lat: 43.6532, lng: -79.3832 });
    expect(res.status).toBe(200);
    const names = res.body.map((l) => l.name);
    expect(names).toContain('Nearby Widget');
    expect(names).toContain('No Coord Widget');
    expect(names).not.toContain('Far Widget');
    const nearbyIdx = names.indexOf('Nearby Widget');
    const noCoordIdx = names.indexOf('No Coord Widget');
    expect(nearbyIdx).toBeGreaterThanOrEqual(0);
    expect(noCoordIdx).toBeGreaterThanOrEqual(0);
    expect(nearbyIdx).toBeLessThan(noCoordIdx);
  });

  it('rejects non-product_listing type filters (Books)', async () => {
    const res = await request(app)
      .get('/product-listing/')
      .query({ public: 'true', type: 'Books' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a product_listing type/i);
  });
});
