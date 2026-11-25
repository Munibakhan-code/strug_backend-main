import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// Mock the Maps boundary so route resolution is deterministic and offline. 10 km / 20 min
// → economy recommended fare = 17.17 (matches the ride-fare unit test).
vi.mock('../../utils/google-maps.js', () => ({
  getDistanceMatrix: vi.fn(async () => ({ distance: { value: 10000 }, duration: { value: 1200 } })),
  geocodeAddress: vi.fn(async () => ({ lat: 6.9271, lng: 79.8612 })),
  getCountryFromCoords: vi.fn(async () => 'Canada'),
}));

import request from 'supertest';
import { app } from '../../app.js';
import { truncateAll, createUser, closeDb } from '../helpers/db.js';
import { authHeader } from '../helpers/auth.js';

beforeEach(async () => { await truncateAll(); });
afterAll(async () => { await closeDb(); });

describe('POST /ride-request/fare-estimate', () => {
  it('401 without a token', async () => {
    await request(app).post('/ride-request/fare-estimate')
      .send({ pickup: 'A', dropoff: 'B', vehicle_type: 'economy' }).expect(401);
  });

  it('400 when pickup/dropoff/vehicle_type missing', async () => {
    const u = await createUser();
    await request(app).post('/ride-request/fare-estimate').set(authHeader(u))
      .send({ pickup: 'A' }).expect(400);
  });

  it('returns the recommended economy breakdown (10km/20min → 17.17)', async () => {
    const u = await createUser();
    const res = await request(app).post('/ride-request/fare-estimate').set(authHeader(u))
      .send({ pickup: 'Colombo', dropoff: 'Kandy', vehicle_type: 'economy' })
      .expect(200);
    expect(res.body).toMatchObject({
      successful: true,
      vehicle_type: 'economy',
      dist_km: 10,
      duration_min: 20,
      trip_fare: 16.35,
      service_fee: 0.82,
      total: 17.17,
      route_source: 'distance_matrix',
    });
  });

  it('400 for an unknown vehicle type', async () => {
    const u = await createUser();
    await request(app).post('/ride-request/fare-estimate').set(authHeader(u))
      .send({ pickup: 'A', dropoff: 'B', vehicle_type: 'rocket' }).expect(400);
  });
});
