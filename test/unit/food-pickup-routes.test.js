process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_unit';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const authUser = { current: { user_id: 42, role: 'USER' } };

vi.mock('../../middleware/authentication.js', () => ({
  authenticateToken: (req, _res, next) => { req.user = { ...authUser.current }; next(); },
  optionalAuth: (req, _res, next) => next(),
  requireAdmin: (req, _res, next) => next(),
}));

vi.mock('../../middleware/food-vendor-check.js', () => ({
  isFoodVendor: (req, _res, next) => {
    req.foodVendor = { vendor_id: 5, vendor_type_id: 9, owner_id: 77 };
    next();
  },
}));

vi.mock('../../services/notify.js', () => ({ notify: vi.fn() }));
vi.mock('../../utils/mailer.js', () => ({ sendEmail: vi.fn(() => Promise.resolve()) }));
vi.mock('../../utils/crypto.js', () => ({ decrypt: vi.fn((value) => value) }));
vi.mock('../../utils/google-maps.js', () => ({
  getDistanceMatrix: vi.fn(),
  geocodeAddress: vi.fn(),
}));
vi.mock('../../utils/ads-delivery-engine.js', () => ({
  selectBestAd: vi.fn(),
  trackAdEvent: vi.fn(),
}));
vi.mock('../../services/food-payout.js', () => ({
  tryCreditSettledFoodOrder: vi.fn(async () => null),
  reverseFoodOrderWalletCredit: vi.fn(async () => null),
}));

const { resolveDeliveryDriverForUser } = vi.hoisted(() => ({
  resolveDeliveryDriverForUser: vi.fn(),
}));
vi.mock('../../utils/driver-identity.js', () => ({ resolveDeliveryDriverForUser }));

const prismaMock = {
  user: { findUnique: vi.fn() },
  vendor_type: { findMany: vi.fn() },
  food_vendor: { findUnique: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
  food_item: { findMany: vi.fn() },
  food_order: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  food_order_items: { createMany: vi.fn() },
  driver_profile: { findMany: vi.fn() },
  $transaction: vi.fn(),
};

vi.mock('../../utils/prisma-client.js', () => ({ default: prismaMock }));

const router = (await import('../../routes/food-routes.js')).default;

const app = express();
app.use(express.json());
app.set('io', { to: vi.fn(() => ({ emit: vi.fn() })) });
app.use('/food', router);

const pickupOrder = {
  food_order_id: 9,
  user_id: 42,
  vendor_id: 5,
  driver_id: null,
  order_status: 'confirmed',
  fulfillment_mode: 'pickup',
  deliver_location: '__SELF_PICKUP__',
  delivery_fee: 0,
  food_vendor: { owner_id: 77, vendor_name: 'Test Kitchen', location: '10 Market St' },
};

describe('pickup order driver listing, claim, PUT lock, picked-up authz', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authUser.current = { user_id: 42, role: 'USER' };
    resolveDeliveryDriverForUser.mockResolvedValue({
      driver_id: 11,
      driver_profile_id: 11,
      current_lat: 29.7,
      current_long: 72.5,
    });
    prismaMock.$transaction.mockImplementation((fn) => fn(prismaMock));
    prismaMock.vendor_type.findMany.mockResolvedValue([
      { vendor_type_id: 7, vendor_type: 'Catering' },
    ]);
  });

  it('GET /orders/available filters pickup at the query and hides the sentinel', async () => {
    prismaMock.food_order.findMany.mockResolvedValue([{
      food_order_id: 3,
      order_status: 'confirmed',
      deliver_location: '20 Queen St',
      fulfillment_mode: 'delivery',
      food_vendor: { vendor_name: 'Test Kitchen', lat: 29.7, long: 72.5 },
      user: { name: 'Buyer' },
      food_order_items: [],
    }]);

    const res = await request(app).get('/food/orders/available');

    expect(res.status).toBe(200);
    expect(prismaMock.food_order.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        order_status: 'confirmed',
        driver_id: null,
        fulfillment_mode: 'delivery',
        NOT: { deliver_location: '__SELF_PICKUP__' },
        OR: [
          { vendor_type_id: null },
          { vendor_type_id: { notIn: [7] } },
        ],
      }),
    }));
    expect(res.body.data[0].deliver_location).toBe('20 Queen St');
    expect(res.body.data[0].fulfillment_mode).toBe('delivery');
  });

  it('GET /orders/available never serializes the self-pickup sentinel', async () => {
    prismaMock.food_order.findMany.mockResolvedValue([{
      food_order_id: 9,
      order_status: 'confirmed',
      deliver_location: '__SELF_PICKUP__',
      fulfillment_mode: 'pickup',
      food_vendor: { vendor_name: 'Test Kitchen' },
      user: { name: 'Buyer' },
      food_order_items: [],
    }]);

    const res = await request(app).get('/food/orders/available');

    expect(res.status).toBe(200);
    expect(res.body.data[0].deliver_location).toBeNull();
    expect(res.body.data[0].fulfillment_mode).toBe('pickup');
  });

  it('PUT /claim-additional refuses pickup rows in the atomic where', async () => {
    prismaMock.food_order.findFirst.mockResolvedValue({
      food_order_id: 1,
      vendor_id: 5,
      driver_id: 11,
      order_status: 'preparing',
      batch_id: 4,
      fulfillment_mode: 'delivery',
    });
    prismaMock.food_order.findUnique.mockResolvedValue({
      food_order_id: 9,
      vendor_id: 5,
      order_status: 'confirmed',
      order_flow: 'food',
      driver_id: null,
      driver_earning: null,
      deliver_location: '__SELF_PICKUP__',
      fulfillment_mode: 'pickup',
      food_vendor: { vendor_type: { vendor_type: 'food' } },
      vendor_type: { vendor_type: 'food' },
    });
    prismaMock.food_order.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(app).put('/food/orders/9/claim-additional');

    expect(res.status).toBe(409);
    expect(prismaMock.food_order.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        food_order_id: 9,
        vendor_id: 5,
        driver_id: null,
        fulfillment_mode: 'delivery',
        NOT: { deliver_location: '__SELF_PICKUP__' },
        OR: [
          { vendor_type_id: null },
          { vendor_type_id: { notIn: [7] } },
        ],
      }),
    }));
  });

  it('PUT /orders/:id rejects converting a pickup order into free delivery', async () => {
    prismaMock.food_order.findUnique.mockResolvedValue(pickupOrder);

    const res = await request(app)
      .put('/food/orders/9')
      .send({ deliver_location: '123 Main St' });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/cannot change delivery address/i);
    expect(prismaMock.food_order.update).not.toHaveBeenCalled();
  });

  it('PUT /orders/:id rejects flipping fulfillment_mode after create', async () => {
    prismaMock.food_order.findUnique.mockResolvedValue(pickupOrder);

    const res = await request(app)
      .put('/food/orders/9')
      .send({ fulfillment_mode: 'delivery' });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/cannot be changed/i);
    expect(prismaMock.food_order.update).not.toHaveBeenCalled();
  });

  it('PATCH /picked-up allows the restaurant on a self-pickup order', async () => {
    authUser.current = { user_id: 77, role: 'USER' };
    resolveDeliveryDriverForUser.mockResolvedValue(null);
    prismaMock.food_order.findUnique.mockResolvedValue({
      ...pickupOrder,
      order_status: 'ready_for_pickup',
    });
    prismaMock.food_order.update.mockResolvedValue({
      ...pickupOrder,
      order_status: 'picked_up',
      user_id: 42,
    });

    const res = await request(app).patch('/food/orders/9/picked-up');

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/self-pickup/i);
    expect(prismaMock.food_order.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        order_status: 'picked_up',
        otp_code: null,
      }),
    }));
  });

  it('PATCH /picked-up 403s a courier on a self-pickup order', async () => {
    authUser.current = { user_id: 88, role: 'USER' };
    resolveDeliveryDriverForUser.mockResolvedValue({
      driver_id: 11,
      driver_profile_id: 11,
    });
    prismaMock.food_order.findUnique.mockResolvedValue({
      ...pickupOrder,
      driver_id: 11,
      order_status: 'ready_for_pickup',
    });

    const res = await request(app).patch('/food/orders/9/picked-up');

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/only the restaurant/i);
    expect(prismaMock.food_order.update).not.toHaveBeenCalled();
  });

  it('PATCH /picked-up allows the assigned courier on a delivery order', async () => {
    authUser.current = { user_id: 88, role: 'USER' };
    resolveDeliveryDriverForUser.mockResolvedValue({
      driver_id: 11,
      driver_profile_id: 11,
    });
    prismaMock.food_order.findUnique.mockResolvedValue({
      food_order_id: 9,
      user_id: 42,
      driver_id: 11,
      order_status: 'ready_for_pickup',
      fulfillment_mode: 'delivery',
      deliver_location: '20 Queen St',
      food_vendor: { owner_id: 77 },
    });
    prismaMock.food_order.update.mockResolvedValue({
      food_order_id: 9,
      user_id: 42,
      order_status: 'picked_up',
    });

    const res = await request(app).patch('/food/orders/9/picked-up');

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/otp/i);
    expect(prismaMock.food_order.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        order_status: 'picked_up',
      }),
    }));
    const otp = prismaMock.food_order.update.mock.calls[0][0].data.otp_code;
    expect(otp).toMatch(/^\d{6}$/);
  });
});
