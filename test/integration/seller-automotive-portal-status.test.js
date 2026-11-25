import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../app.js';
import { db, createUser, truncateAll, closeDb } from '../helpers/db.js';
import { authHeader } from '../helpers/auth.js';

// Drives useAutomotiveGate on the frontend: GET /seller-portals/me/status must report
// statuses['sd-automotive'] = true only for users who actually applied to the automotive
// portal, not any user with an appointment_service_providers row for a sibling portal
// (sd-services/sd-proservices/sd-decor/... all share that same table).

describe('seller automotive dashboard — portal gate status (sd-automotive)', () => {
  let user;

  beforeEach(async () => {
    await truncateAll();
    user = await createUser({ name: 'Prospective Automotive Seller' });
  });

  afterAll(async () => {
    await truncateAll();
    await closeDb();
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/seller-portals/me/status');
    expect(res.status).toBe(401);
  });

  it('reports false when the user has no service-provider registration at all', async () => {
    const res = await request(app).get('/seller-portals/me/status').set(authHeader(user));
    expect(res.status).toBe(200);
    expect(res.body.data.statuses['sd-automotive']).toBe(false);
  });

  it('reports true once the user has an appointment_service_providers row tagged sd-automotive', async () => {
    await db.appointment_service_providers.create({
      data: { service_provider_user_id: user.user_id, service_type: 'sd-automotive', company_name: 'Auto Co' },
    });

    const res = await request(app).get('/seller-portals/me/status').set(authHeader(user));
    expect(res.status).toBe(200);
    expect(res.body.data.statuses['sd-automotive']).toBe(true);
  });

  it('does not report sd-automotive as active for a registration under a sibling service_type', async () => {
    await db.appointment_service_providers.create({
      data: { service_provider_user_id: user.user_id, service_type: 'sd-services', company_name: 'Some Other Service' },
    });

    const res = await request(app).get('/seller-portals/me/status').set(authHeader(user));
    expect(res.status).toBe(200);
    expect(res.body.data.statuses['sd-automotive']).toBe(false);
  });
});
