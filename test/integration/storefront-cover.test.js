import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../app.js';
import { db, createUser, truncateAll, closeDb } from '../helpers/db.js';
import { authHeader } from '../helpers/auth.js';

// Verifies the storefront cover_url column + validation added for bug board #176/#177/#319.
// Exercises the string-URL write paths (PUT /food/vendors/:id and PUT /user/:id/store_profile)
// and the branding-upload validation branch. The actual multipart→blob upload mirrors the
// proven channel /branding/upload pattern and is smoke-tested against prod post-deploy.

describe('storefront cover photos', () => {
  let foodOwner, vendor, storeOwner;

  beforeAll(async () => {
    await truncateAll();
    foodOwner = await createUser();
    vendor = await db.food_vendor.create({ data: { owner_id: foodOwner.user_id, vendor_name: 'Test Kitchen', is_active: true } });
    storeOwner = await createUser();
  });

  afterAll(async () => { await truncateAll(); await closeDb(); });

  it('food PUT accepts + persists cover_url', async () => {
    const url = 'https://cdn.example.com/storefront/food-cover-1.jpg';
    const res = await request(app)
      .put(`/food/vendors/${vendor.vendor_id}`)
      .set(authHeader(foodOwner))
      .send({ cover_url: url });
    expect(res.status).toBe(200);
    expect(res.body.cover_url).toBe(url);

    const row = await db.food_vendor.findUnique({ where: { vendor_id: vendor.vendor_id } });
    expect(row.cover_url).toBe(url);
  });

  it('food branding upload rejects a bad type with 400 (no file)', async () => {
    const res = await request(app)
      .post(`/food/vendors/${vendor.vendor_id}/branding`)
      .set(authHeader(foodOwner))
      .field('type', 'banner'); // invalid + no image
    expect(res.status).toBe(400);
  });

  it('food branding upload rejects a non-image (SVG) mime with 400', async () => {
    const res = await request(app)
      .post(`/food/vendors/${vendor.vendor_id}/branding`)
      .set(authHeader(foodOwner))
      .field('type', 'cover')
      .attach('image', Buffer.from('<svg onload="alert(1)"></svg>'), { filename: 'x.svg', contentType: 'image/svg+xml' });
    expect(res.status).toBe(400);
  });

  it('food PUT is IDOR-safe: a non-owner cannot mutate the vendor', async () => {
    const attacker = await createUser();
    // attacker also owns a vendor so isFoodVendor passes, but targets someone else's :id
    await db.food_vendor.create({ data: { owner_id: attacker.user_id, vendor_name: 'Attacker Kitchen', is_active: true } });
    const res = await request(app)
      .put(`/food/vendors/${vendor.vendor_id}`)
      .set(authHeader(attacker))
      .send({ vendor_name: 'HACKED' });
    expect(res.status).toBe(403);
    const row = await db.food_vendor.findUnique({ where: { vendor_id: vendor.vendor_id } });
    expect(row.vendor_name).not.toBe('HACKED');
  });

  it('store PUT accepts + persists cover_url (upsert)', async () => {
    const url = 'https://cdn.example.com/storefront/store-cover-1.jpg';
    const res = await request(app)
      .put(`/user/${storeOwner.user_id}/store_profile`)
      .set(authHeader(storeOwner))
      .send({ store_name: 'My Shop', cover_url: url });
    expect(res.status).toBe(200);
    expect(res.body.cover_url).toBe(url);
  });

  it('store PUT rejects a non-URL cover_url', async () => {
    const res = await request(app)
      .put(`/user/${storeOwner.user_id}/store_profile`)
      .set(authHeader(storeOwner))
      .send({ cover_url: 'not-a-url' });
    expect(res.status).toBe(400);
  });

  it('store PUT clears cover_url on empty string', async () => {
    const res = await request(app)
      .put(`/user/${storeOwner.user_id}/store_profile`)
      .set(authHeader(storeOwner))
      .send({ cover_url: '' });
    expect(res.status).toBe(200);
    expect(res.body.cover_url).toBeNull();
  });

  it('food PUT accepts + clears banner_url (Remove banner)', async () => {
    const url = 'https://cdn.example.com/storefront/food-banner-1.jpg';
    const setRes = await request(app)
      .put(`/food/vendors/${vendor.vendor_id}`)
      .set(authHeader(foodOwner))
      .send({ banner_url: url });
    expect(setRes.status).toBe(200);
    expect(setRes.body.banner_url).toBe(url);

    const clearRes = await request(app)
      .put(`/food/vendors/${vendor.vendor_id}`)
      .set(authHeader(foodOwner))
      .send({ banner_url: null });
    expect(clearRes.status).toBe(200);
    expect(clearRes.body.banner_url).toBeNull();

    const row = await db.food_vendor.findUnique({ where: { vendor_id: vendor.vendor_id } });
    expect(row.banner_url).toBeNull();
  });

  it('store PUT accepts + clears banner_url', async () => {
    const url = 'https://cdn.example.com/storefront/store-banner-1.jpg';
    const setRes = await request(app)
      .put(`/user/${storeOwner.user_id}/store_profile`)
      .set(authHeader(storeOwner))
      .send({ banner_url: url });
    expect(setRes.status).toBe(200);
    expect(setRes.body.banner_url).toBe(url);

    const clearRes = await request(app)
      .put(`/user/${storeOwner.user_id}/store_profile`)
      .set(authHeader(storeOwner))
      .send({ banner_url: null });
    expect(clearRes.status).toBe(200);
    expect(clearRes.body.banner_url).toBeNull();
  });
});
