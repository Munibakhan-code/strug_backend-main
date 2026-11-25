import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../app.js';
import { db, createUser, truncateAll, closeDb } from '../helpers/db.js';
import { authHeader } from '../helpers/auth.js';

// Seller automotive dashboard "Requests" tab: buyers submit test-drive requests against a
// listing, the seller (derived from the vehicle's owner, never the client) accepts/declines
// them. Covers slot double-booking, the buyer's one-active-request-per-vehicle rule, and the
// seller/buyer authorization split on status updates vs cancellation.

function requestFields(vehicleId, overrides = {}) {
  return {
    vehicle_id: vehicleId,
    preferred_date: '2026-09-01',
    preferred_time: '10:00 AM',
    full_name: 'Jane Buyer',
    phone_number: '555-0100',
    email: 'jane@example.com',
    ...overrides,
  };
}

describe('seller automotive dashboard — test drive requests', () => {
  let seller, buyer, otherBuyer;
  let vehicle;

  beforeEach(async () => {
    await truncateAll();
    seller = await createUser({ name: 'Automotive Seller' });
    buyer = await createUser({ name: 'Buyer One' });
    otherBuyer = await createUser({ name: 'Buyer Two' });
    vehicle = await db.vehicle.create({
      data: { user_id: seller.user_id, make: 'Toyota', model: 'Corolla', year: 2020, price: 15000, vehicle_type: 'Cars' },
    });
  });

  afterAll(async () => {
    await truncateAll();
    await closeDb();
  });

  describe('POST /test-drive', () => {
    it('rejects unauthenticated requests', async () => {
      const res = await request(app).post('/test-drive').send(requestFields(vehicle.vehicle_id));
      expect(res.status).toBe(401);
    });

    it('rejects when required fields are missing', async () => {
      const res = await request(app)
        .post('/test-drive')
        .set(authHeader(buyer))
        .send(requestFields(vehicle.vehicle_id, { full_name: undefined }));
      expect(res.status).toBe(400);
    });

    it('returns 404 for a vehicle that does not exist', async () => {
      const res = await request(app)
        .post('/test-drive')
        .set(authHeader(buyer))
        .send(requestFields(999999));
      expect(res.status).toBe(404);
    });

    it('returns 404 for a vehicle with no owner (e.g. a driver-only rideshare vehicle)', async () => {
      const orphanVehicle = await db.vehicle.create({ data: { plate_number: 'NOOWN1', model: 'Unowned' } });
      const res = await request(app)
        .post('/test-drive')
        .set(authHeader(buyer))
        .send(requestFields(orphanVehicle.vehicle_id));
      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/no owner/);
    });

    it('derives seller_id from the vehicle owner and ignores a client-supplied seller_id', async () => {
      const res = await request(app)
        .post('/test-drive')
        .set(authHeader(buyer))
        .send(requestFields(vehicle.vehicle_id, { seller_id: otherBuyer.user_id }));

      expect(res.status).toBe(201);
      expect(res.body.data.seller_id).toBe(seller.user_id);
    });

    it('creates a request with the authenticated user as buyer', async () => {
      const res = await request(app)
        .post('/test-drive')
        .set(authHeader(buyer))
        .send(requestFields(vehicle.vehicle_id));

      expect(res.status).toBe(201);
      expect(res.body.data.buyer_id).toBe(buyer.user_id);
      expect(res.body.data.status).toBe('PENDING');
    });

    it('rejects a second request for the same vehicle/date/time slot (still open)', async () => {
      await request(app).post('/test-drive').set(authHeader(buyer)).send(requestFields(vehicle.vehicle_id));

      const res = await request(app)
        .post('/test-drive')
        .set(authHeader(otherBuyer))
        .send(requestFields(vehicle.vehicle_id));

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/already booked/);
    });

    it('rejects a buyer who already has an active request for the same vehicle', async () => {
      await request(app).post('/test-drive').set(authHeader(buyer)).send(requestFields(vehicle.vehicle_id));

      const res = await request(app)
        .post('/test-drive')
        .set(authHeader(buyer))
        .send(requestFields(vehicle.vehicle_id, { preferred_time: '2:00 PM' }));

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/already have an active test drive request/);
    });

    it('allows re-booking the same vehicle after the prior request was cancelled', async () => {
      const first = await request(app).post('/test-drive').set(authHeader(buyer)).send(requestFields(vehicle.vehicle_id));
      await request(app).delete(`/test-drive/${first.body.data.test_drive_request_id}`).set(authHeader(buyer));

      const res = await request(app)
        .post('/test-drive')
        .set(authHeader(buyer))
        .send(requestFields(vehicle.vehicle_id, { preferred_time: '3:00 PM' }));

      expect(res.status).toBe(201);
    });
  });

  describe('GET /test-drive/seller-requests', () => {
    it('rejects unauthenticated requests', async () => {
      const res = await request(app).get('/test-drive/seller-requests');
      expect(res.status).toBe(401);
    });

    it('only returns requests where the caller is the seller', async () => {
      await request(app).post('/test-drive').set(authHeader(buyer)).send(requestFields(vehicle.vehicle_id));

      const asSeller = await request(app).get('/test-drive/seller-requests').set(authHeader(seller));
      expect(asSeller.status).toBe(200);
      expect(asSeller.body.data).toHaveLength(1);

      const asBuyer = await request(app).get('/test-drive/seller-requests').set(authHeader(buyer));
      expect(asBuyer.body.data).toHaveLength(0);
    });
  });

  describe('PUT /test-drive/:id/status', () => {
    async function createPendingRequest() {
      const res = await request(app).post('/test-drive').set(authHeader(buyer)).send(requestFields(vehicle.vehicle_id));
      return res.body.data;
    }

    it('rejects an invalid status value', async () => {
      const req = await createPendingRequest();
      const res = await request(app)
        .put(`/test-drive/${req.test_drive_request_id}/status`)
        .set(authHeader(seller))
        .send({ status: 'APPROVED' });
      expect(res.status).toBe(400);
    });

    it('rejects the buyer trying to update status (seller-only action)', async () => {
      const req = await createPendingRequest();
      const res = await request(app)
        .put(`/test-drive/${req.test_drive_request_id}/status`)
        .set(authHeader(buyer))
        .send({ status: 'CONFIRMED' });
      expect(res.status).toBe(403);
    });

    it('returns 404 for a request id that does not exist', async () => {
      const res = await request(app)
        .put('/test-drive/999999/status')
        .set(authHeader(seller))
        .send({ status: 'CONFIRMED' });
      expect(res.status).toBe(404);
    });

    it('lets the seller confirm a pending request', async () => {
      const req = await createPendingRequest();
      const res = await request(app)
        .put(`/test-drive/${req.test_drive_request_id}/status`)
        .set(authHeader(seller))
        .send({ status: 'CONFIRMED' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('CONFIRMED');
    });
  });

  describe('DELETE /test-drive/:id — buyer cancellation', () => {
    async function createPendingRequest() {
      const res = await request(app).post('/test-drive').set(authHeader(buyer)).send(requestFields(vehicle.vehicle_id));
      return res.body.data;
    }

    it('rejects the seller trying to cancel (buyer-only action)', async () => {
      const req = await createPendingRequest();
      const res = await request(app).delete(`/test-drive/${req.test_drive_request_id}`).set(authHeader(seller));
      expect(res.status).toBe(403);
    });

    it('rejects cancelling a completed request', async () => {
      const req = await createPendingRequest();
      await request(app)
        .put(`/test-drive/${req.test_drive_request_id}/status`)
        .set(authHeader(seller))
        .send({ status: 'COMPLETED' });

      const res = await request(app).delete(`/test-drive/${req.test_drive_request_id}`).set(authHeader(buyer));
      expect(res.status).toBe(400);
    });

    it('marks the request CANCELLED rather than deleting the row', async () => {
      const req = await createPendingRequest();
      const res = await request(app).delete(`/test-drive/${req.test_drive_request_id}`).set(authHeader(buyer));

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('CANCELLED');
      expect(await db.test_drive_request.findUnique({ where: { test_drive_request_id: req.test_drive_request_id } })).not.toBeNull();
    });
  });
});
