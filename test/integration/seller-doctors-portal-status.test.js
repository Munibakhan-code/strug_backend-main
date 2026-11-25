import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../app.js';
import { db, createUser, truncateAll, closeDb } from '../helpers/db.js';
import { authHeader } from '../helpers/auth.js';

describe('seller doctors portal — portal gate status (sd-doctors)', () => {
  let user;

  beforeEach(async () => {
    await truncateAll();
    user = await createUser({ name: 'Prospective Doctor' });
  });

  afterAll(async () => {
    await truncateAll();
    await closeDb();
  });

  it('reports false with no doctor registration', async () => {
    const res = await request(app).get('/seller-portals/me/status').set(authHeader(user));
    expect(res.status).toBe(200);
    expect(res.body.data.statuses['sd-doctors']).toBe(false);
  });

  it('reports true for appointment_service_providers tagged sd-doctors', async () => {
    await db.appointment_service_providers.create({
      data: { service_provider_user_id: user.user_id, service_type: 'sd-doctors', company_name: 'Doc Co' },
    });
    const res = await request(app).get('/seller-portals/me/status').set(authHeader(user));
    expect(res.status).toBe(200);
    expect(res.body.data.statuses['sd-doctors']).toBe(true);
  });

  it('does not light up sd-doctors for a sibling service_type', async () => {
    await db.appointment_service_providers.create({
      data: { service_provider_user_id: user.user_id, service_type: 'sd-automotive', company_name: 'Auto Co' },
    });
    const res = await request(app).get('/seller-portals/me/status').set(authHeader(user));
    expect(res.status).toBe(200);
    expect(res.body.data.statuses['sd-doctors']).toBe(false);
  });

  it('reports true when the user owns a medical booking_listing (Phase 0 backfill)', async () => {
    await db.booking_listing.create({
      data: {
        vertical: 'medical',
        owner_id: user.user_id,
        title: 'Dr Test — Online',
        price: 60,
        price_unit: 'session',
        attributes: { type: 'medical', mode: 'online', group_id: `med_user_${user.user_id}` },
      },
    });
    const res = await request(app).get('/seller-portals/me/status').set(authHeader(user));
    expect(res.status).toBe(200);
    expect(res.body.data.statuses['sd-doctors']).toBe(true);
  });
});
