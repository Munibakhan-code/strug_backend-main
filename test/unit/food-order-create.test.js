process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_unit';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../../middleware/authentication.js', () => ({
  authenticateToken: (req, _res, next) => { req.user = { user_id: 42, name: 'Buyer' }; next(); },
  optionalAuth: (req, _res, next) => next(),
  requireAdmin: (req, _res, next) => next(),
}));

vi.mock('../../middleware/food-vendor-check.js', () => ({
  isFoodVendor: (req, _res, next) => {
    req.foodVendor = { vendor_id: 5, vendor_type_id: 9, owner_id: 77 };
    next();
  },
}));

vi.mock('../../services/notify.js', () => ({
  notify: vi.fn(),
}));

vi.mock('../../utils/mailer.js', () => ({
  sendEmail: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../utils/crypto.js', () => ({
  decrypt: vi.fn((value) => value),
}));

vi.mock('../../utils/google-maps.js', () => ({
  getDistanceMatrix: vi.fn(),
  geocodeAddress: vi.fn(),
}));

vi.mock('../../utils/ads-delivery-engine.js', () => ({
  selectBestAd: vi.fn(),
  trackAdEvent: vi.fn(),
}));

const prismaMock = {
  user: { findUnique: vi.fn() },
  vendor_type: { findMany: vi.fn(), findUnique: vi.fn() },
  food_vendor: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
  food_vendor_closure: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  food_category: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  food_item: { create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  food_item_pics: { create: vi.fn(), deleteMany: vi.fn() },
  food_item_modifier_option: { findMany: vi.fn() },
  food_order: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
  food_order_rating: { groupBy: vi.fn(), aggregate: vi.fn() },
  food_order_items: { createMany: vi.fn(), groupBy: vi.fn() },
  stripe_orphan_payment: { findUnique: vi.fn(), update: vi.fn() },
  ads_campaign: { findFirst: vi.fn() },
  strug_wallet: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  wallet_transaction: { create: vi.fn() },
  promotion: { findMany: vi.fn() },
  $transaction: vi.fn(),
};

const { stripeRetrieve } = vi.hoisted(() => ({ stripeRetrieve: vi.fn() }));
vi.mock('stripe', () => ({
  default: function Stripe() {
    this.paymentIntents = { retrieve: stripeRetrieve };
  },
}));

vi.mock('../../utils/prisma-client.js', () => ({
  default: prismaMock,
}));

const router = (await import('../../routes/food-routes.js')).default;
const { getDistanceMatrix } = await import('../../utils/google-maps.js');
const { sendEmail } = await import('../../utils/mailer.js');

const app = express();
app.use(express.json());
app.set('io', { to: vi.fn(() => ({ emit: vi.fn() })) });
app.use('/food', router);

describe('POST /food/orders with cart items', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.user.findUnique.mockResolvedValue({ saved_address: '10 King St', name: 'Buyer', country: 'Canada', currency: 'CAD' });
    prismaMock.food_vendor.findUnique.mockResolvedValue({
      owner_id: 77,
      is_active: true,
      is_paused: false,
      vendor_type_id: 9,
      location: '10 Market St',
    });
    prismaMock.food_vendor_closure.findFirst.mockResolvedValue(null);
    getDistanceMatrix.mockResolvedValue({ distance: { value: 800 } });
    prismaMock.food_item_modifier_option.findMany.mockResolvedValue([]);
    prismaMock.strug_wallet.findUnique.mockResolvedValue({ user_id: 42, balance: 999, status: 'active' });
    prismaMock.strug_wallet.update.mockResolvedValue({ user_id: 42, balance: 900, status: 'active' });
    prismaMock.strug_wallet.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.wallet_transaction.create.mockResolvedValue({ transaction_id: 1 });
    prismaMock.$transaction.mockImplementation((fn) => fn(prismaMock));
    prismaMock.food_order.create.mockResolvedValue({
      food_order_id: 123,
      user_id: 42,
      vendor_id: 5,
      vendor_type_id: 9,
      ispaid: true,
    });
    prismaMock.food_order_items.groupBy.mockResolvedValue([]);
    prismaMock.food_order.findUnique.mockResolvedValue({
      food_order_id: 123,
      vendor_id: 5,
      food_order_items: [],
    });
    prismaMock.ads_campaign.findFirst.mockResolvedValue(null);
  });

	  it('creates order items and decrements stock atomically', async () => {
    prismaMock.food_item.findMany.mockResolvedValue([
      { food_item_id: 10, vendor_id: 5, vendor_type_id: 9, name: 'Milk', price: 4, is_available: true, stock_qty: 5 },
      { food_item_id: 11, vendor_id: 5, vendor_type_id: 9, name: 'Eggs', price: 6, is_available: true, stock_qty: 8 },
    ]);
    prismaMock.food_item.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .post('/food/orders')
      .send({
        vendor_id: 5,
        vendor_type_id: 9,
        payment_method: 'WALLET',
        delivery_fee: 2,
        deliver_location: '20 Queen St',
        items: [
          { food_item_id: 10, qty: 2 },
          { id: 11, qty: 1 },
        ],
      });

    expect(res.status).toBe(201);
    expect(prismaMock.food_order.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        user_id: 42,
        vendor_id: 5,
        vendor_type_id: 9,
	        total_amount: 19.09,
	        delivery_fee: 2,
	        platform_fee: 1.12,
        ispaid: true,
      }),
    }));
    expect(prismaMock.food_order_items.createMany).toHaveBeenCalledWith({
      data: [
	        { order_id: 123, food_item_id: 10, qty: 2, price_item: 4, modifier_option_ids: [], special_instructions: null, vendor_type_id: 9 },
	        { order_id: 123, food_item_id: 11, qty: 1, price_item: 6, modifier_option_ids: [], special_instructions: null, vendor_type_id: 9 },
      ],
    });
	    expect(prismaMock.food_item.updateMany).toHaveBeenCalledTimes(2);
	  });

  it('accepts a catering venue address outside the 25km courier radius', async () => {
    prismaMock.food_vendor.findUnique.mockResolvedValue({
      owner_id: 77,
      is_active: true,
      is_paused: false,
      vendor_type_id: 5,
      location: 'Toronto',
      lat: 43.65,
      long: -79.38,
      vendor_type: { vendor_type: 'Catering' },
    });
    getDistanceMatrix.mockResolvedValue({ distance: { value: 1_200_000 } });
    prismaMock.food_item.findMany.mockResolvedValue([
      { food_item_id: 10, vendor_id: 5, vendor_type_id: 5, name: 'Tray', price: 80, is_available: true, stock_qty: null },
    ]);
    prismaMock.food_order.create.mockResolvedValue({
      food_order_id: 321,
      user_id: 42,
      vendor_id: 5,
      vendor_type_id: 5,
      ispaid: true,
    });
    prismaMock.food_order.findUnique.mockResolvedValue({
      food_order_id: 321,
      vendor_id: 5,
      vendor_type: { vendor_type: 'Catering' },
      food_order_items: [],
    });

    const res = await request(app)
      .post('/food/orders')
      .send({
        vendor_id: 5,
        payment_method: 'WALLET',
        deliver_location: 'Lahore Convention Centre',
        items: [{ food_item_id: 10, qty: 1 }],
      });

    expect(res.status).toBe(201);
    expect(prismaMock.food_order.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        delivery_fee: 0,
        vendor_type_id: 5,
      }),
    }));
  });

	  it('prices and persists selected paid modifiers on the order line', async () => {
	    prismaMock.food_item.findMany.mockResolvedValue([
	      { food_item_id: 10, vendor_id: 5, vendor_type_id: 9, name: 'Burger', price: 20, is_available: true, stock_qty: 5 },
	    ]);
	    prismaMock.food_item_modifier_option.findMany.mockResolvedValue([
	      { option_id: 101, price: 2, group: { food_item_id: 10 } },
	      { option_id: 102, price: 5, group: { food_item_id: 10 } },
	    ]);
	    prismaMock.food_item.updateMany.mockResolvedValue({ count: 1 });

	    const res = await request(app)
	      .post('/food/orders')
	      .send({
	        vendor_id: 5,
	        payment_method: 'WALLET',
	        deliver_location: '20 Queen St',
	        delivery_instructions: '[Tip: $3.50] Please make it spicy',
	        items: [
	          {
	            food_item_id: 10,
	            qty: 1,
	            modifier_option_ids: [102, 101],
	            special_instructions: 'Extra napkins',
	          },
	        ],
	      });

	    expect(res.status).toBe(201);
	    expect(prismaMock.food_order.create).toHaveBeenCalledWith(expect.objectContaining({
	      data: expect.objectContaining({
	        total_amount: 38.45,
	        delivery_fee: 2,
	        platform_fee: 2.16,
	        tip_amount: 3.5,
	        ispaid: true,
	      }),
	    }));
	    expect(prismaMock.food_order_items.createMany).toHaveBeenCalledWith({
	      data: [
	        {
	          order_id: 123,
	          food_item_id: 10,
	          qty: 1,
	          price_item: 27,
	          modifier_option_ids: [101, 102],
	          special_instructions: 'Extra napkins',
	          vendor_type_id: 9,
	        },
	      ],
	    });
	  });

  it('ignores client-supplied money fields when cart items provide server pricing', async () => {
    prismaMock.food_item.findMany.mockResolvedValue([
      { food_item_id: 10, vendor_id: 5, vendor_type_id: 9, name: 'Milk', price: 4, is_available: true, stock_qty: 5 },
    ]);
    prismaMock.food_item.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .post('/food/orders')
      .send({
        vendor_id: 5,
        vendor_type_id: 9,
        payment_method: 'WALLET',
        delivery_fee: 999,
        platform_fee: 0,
        total_amount: 0.01,
        deliver_location: '20 Queen St',
        items: [{ food_item_id: 10, qty: 2 }],
      });

    expect(res.status).toBe(201);
    expect(prismaMock.food_order.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
	        total_amount: 11.76,
	        delivery_fee: 2,
	        platform_fee: 0.64,
        ispaid: true,
      }),
    }));
    expect(getDistanceMatrix).toHaveBeenCalledWith('10 Market St', '20 Queen St');
    expect(getDistanceMatrix.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.$transaction.mock.invocationCallOrder[0]);
  });

  it('uses the vendor type from the store instead of trusting the client', async () => {
    prismaMock.food_item.findMany.mockResolvedValue([
      { food_item_id: 10, vendor_id: 5, vendor_type_id: 9, name: 'Milk', price: 4, is_available: true, stock_qty: 5 },
    ]);
    prismaMock.food_item.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .post('/food/orders')
      .send({
        vendor_id: 5,
        vendor_type_id: 1,
        payment_method: 'WALLET',
        deliver_location: '20 Queen St',
        items: [{ food_item_id: 10, qty: 1 }],
      });

    expect(res.status).toBe(201);
    expect(prismaMock.food_order.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ vendor_type_id: 9 }),
    }));
  });

  it('falls back to the configured base fee when maps cannot calculate delivery fee', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getDistanceMatrix.mockResolvedValue(null);
    prismaMock.food_item.findMany.mockResolvedValue([
      { food_item_id: 10, vendor_id: 5, vendor_type_id: 9, name: 'Milk', price: 4, is_available: true, stock_qty: 5 },
    ]);
    prismaMock.food_item.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .post('/food/orders')
      .send({
        vendor_id: 5,
        vendor_type_id: 9,
        payment_method: 'WALLET',
        delivery_fee: 0,
        deliver_location: '20 Queen St',
        items: [{ food_item_id: 10, qty: 1 }],
      });

    expect(res.status).toBe(201);
    expect(prismaMock.food_order.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
	        total_amount: 4.88,
	        delivery_fee: 0,
	        platform_fee: 0.32,
      }),
    }));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/Falling back to delivery fee/i));
    warnSpy.mockRestore();
  });

  it('rejects malformed quantities instead of inventing order quantities', async () => {
    prismaMock.food_item.findMany.mockResolvedValue([
      { food_item_id: 10, vendor_id: 5, vendor_type_id: 9, name: 'Milk', price: 4, is_available: true, stock_qty: 3 },
    ]);

    const res = await request(app)
      .post('/food/orders')
      .send({
        vendor_id: 5,
        vendor_type_id: 'bad-value',
        payment_method: 'WALLET',
        delivery_fee: 2,
        items: [
          { food_item_id: 10, qty: 'abc' },
          { food_item_id: 10, qty: -2 },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/invalid quantity/i);
    expect(prismaMock.food_vendor.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.food_order.create).not.toHaveBeenCalled();
  });

  it('rejects invalid store ids before querying Prisma', async () => {
    const res = await request(app)
      .post('/food/orders')
      .send({
        vendor_id: 'not-a-store',
        payment_method: 'WALLET',
        items: [{ food_item_id: 10, qty: 1 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/valid store/i);
    expect(prismaMock.food_vendor.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.food_order.create).not.toHaveBeenCalled();
  });

  it('rejects missing payment method instead of defaulting to an unpaid card order', async () => {
    const res = await request(app)
      .post('/food/orders')
      .send({
        vendor_id: 5,
        items: [{ food_item_id: 10, qty: 1 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/payment method/i);
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.food_vendor.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.food_order.create).not.toHaveBeenCalled();
  });

  it('rejects no-item orders before trusting client supplied totals', async () => {
    const res = await request(app)
      .post('/food/orders')
      .send({
        vendor_id: 5,
        payment_method: 'WALLET',
        total_amount: 0.01,
        platform_fee: 0,
        delivery_fee: 0,
        items: [],
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/order item/i);
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.food_vendor.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.food_order.create).not.toHaveBeenCalled();
  });

  it('ignores malformed client money fields because pricing is server-computed', async () => {
    prismaMock.food_item.findMany.mockResolvedValue([
      { food_item_id: 10, vendor_id: 5, vendor_type_id: 9, name: 'Milk', price: 4, is_available: true, stock_qty: 3 },
    ]);
    prismaMock.food_item.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .post('/food/orders')
      .send({
        vendor_id: 5,
        payment_method: 'WALLET',
        total_amount: 'not-a-total',
        platform_fee: 'not-a-fee',
        deliver_location: '20 Queen St',
        items: [{ food_item_id: 10, qty: 1 }],
      });

    expect(res.status).toBe(201);
    expect(prismaMock.food_order.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
	        total_amount: 6.88,
	        delivery_fee: 2,
	        platform_fee: 0.32,
      }),
    }));
  });

  it('rejects unavailable or under-stocked grocery items before creating the order', async () => {
    prismaMock.food_item.findMany.mockResolvedValue([
      { food_item_id: 10, vendor_id: 5, vendor_type_id: 9, name: 'Milk', price: 4, is_available: true, stock_qty: 1 },
    ]);

    const res = await request(app)
      .post('/food/orders')
      .send({
        vendor_id: 5,
        vendor_type_id: 9,
        payment_method: 'WALLET',
        deliver_location: '20 Queen St',
        items: [{ food_item_id: 10, qty: 3 }],
      });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/insufficient stock/i);
    expect(getDistanceMatrix).not.toHaveBeenCalled();
    expect(prismaMock.food_order.create).not.toHaveBeenCalled();
    expect(prismaMock.food_order_items.createMany).not.toHaveBeenCalled();
  });

  it('rejects courier delivery when deliver_location is missing or blank', async () => {
    prismaMock.food_item.findMany.mockResolvedValue([
      { food_item_id: 10, vendor_id: 5, vendor_type_id: 9, name: 'Milk', price: 4, is_available: true, stock_qty: 5 },
    ]);

    const res = await request(app)
      .post('/food/orders')
      .send({
        vendor_id: 5,
        payment_method: 'WALLET',
        deliver_location: '   ',
        items: [{ food_item_id: 10, qty: 1 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/delivery address is required/i);
    expect(prismaMock.food_order.create).not.toHaveBeenCalled();
  });

  it('does not fall back to saved_address when deliver_location is omitted', async () => {
    prismaMock.food_item.findMany.mockResolvedValue([
      { food_item_id: 10, vendor_id: 5, vendor_type_id: 9, name: 'Milk', price: 4, is_available: true, stock_qty: 5 },
    ]);

    const res = await request(app)
      .post('/food/orders')
      .send({
        vendor_id: 5,
        payment_method: 'WALLET',
        items: [{ food_item_id: 10, qty: 1 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/delivery address is required/i);
    expect(prismaMock.food_order.create).not.toHaveBeenCalled();
  });

  it('writes pickup sentinel with zero fee and tip and skips range/fee lookup', async () => {
    prismaMock.food_item.findMany.mockResolvedValue([
      { food_item_id: 10, vendor_id: 5, vendor_type_id: 9, name: 'Milk', price: 4, is_available: true, stock_qty: 5 },
    ]);
    prismaMock.food_item.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .post('/food/orders')
      .send({
        vendor_id: 5,
        payment_method: 'WALLET',
        fulfillment_mode: 'pickup',
        deliver_location: '20 Queen St',
        tip: 5,
        items: [{ food_item_id: 10, qty: 1 }],
      });

    expect(res.status).toBe(201);
    expect(getDistanceMatrix).not.toHaveBeenCalled();
    expect(prismaMock.food_order.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        fulfillment_mode: 'pickup',
        deliver_location: '__SELF_PICKUP__',
        delivery_fee: 0,
        tip_amount: 0,
      }),
    }));
    expect(res.body.data.fulfillment_mode).toBe('pickup');
    expect(res.body.data.deliver_location).toBeNull();
  });

  it('rejects courier delivery that supplies the self-pickup sentinel as the address', async () => {
    prismaMock.food_item.findMany.mockResolvedValue([
      { food_item_id: 10, vendor_id: 5, vendor_type_id: 9, name: 'Milk', price: 4, is_available: true, stock_qty: 5 },
    ]);

    const res = await request(app)
      .post('/food/orders')
      .send({
        vendor_id: 5,
        payment_method: 'WALLET',
        fulfillment_mode: 'delivery',
        deliver_location: '__SELF_PICKUP__',
        items: [{ food_item_id: 10, qty: 1 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/invalid delivery address/i);
    expect(getDistanceMatrix).not.toHaveBeenCalled();
    expect(prismaMock.food_order.create).not.toHaveBeenCalled();
  });

  it('rejects orders during a scheduled store closure before taking payment', async () => {
    prismaMock.food_vendor_closure.findFirst.mockResolvedValueOnce({
      closure_id: 1,
      vendor_id: 5,
      starts_at: new Date('2026-09-01T12:00:00.000Z'),
      ends_at: new Date('2026-09-01T14:00:00.000Z'),
      reason: 'Holiday',
    });

    const res = await request(app)
      .post('/food/orders')
      .send({
        vendor_id: 5,
        payment_method: 'WALLET',
        deliver_location: '12 King St',
        items: [{ food_item_id: 10, qty: 1 }],
      });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/temporarily closed/i);
    expect(prismaMock.strug_wallet.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.food_order.create).not.toHaveBeenCalled();
  });
});

describe('PATCH /food/orders/:order_id/checkout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation((fn) => fn(prismaMock));
    prismaMock.ads_campaign.findFirst.mockResolvedValue(null);
  });

  it('falls back to the persisted order delivery fee when maps is unavailable', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getDistanceMatrix.mockResolvedValue(null);
    const order = {
      food_order_id: 123,
      user_id: 42,
      deliver_location: '20 Queen St',
      delivery_fee: 3,
      user: { user_id: 42, country: 'Canada', currency: 'CAD', email: 'buyer@example.test' },
      food_vendor: {
        vendor_id: 5,
        owner_id: 77,
        location: '10 Market St',
        user: { user_id: 77, email: 'vendor@example.test', country: 'Canada' },
      },
      food_order_items: [
        { qty: 2, price_item: 4, food_item: { name: 'Milk' } },
      ],
    };
    prismaMock.food_order.findUnique.mockResolvedValue(order);
    prismaMock.food_order.update.mockResolvedValue({
      ...order,
	      total_amount: 12.76,
	      delivery_fee: 3,
	      platform_fee: 0.64,
      order_status: 'confirmed',
      ispaid: true,
    });
    stripeRetrieve.mockResolvedValue({
      id: 'pi_paid',
      status: 'succeeded',
      amount: 1276,
      amount_received: 1276,
      metadata: { user_id: '42', order_id: '123' },
    });

    const res = await request(app)
      .patch('/food/orders/123/checkout')
      .send({ transaction_id: 'pi_paid', payment_method: 'CARD' });

    expect(res.status).toBe(200);
    expect(prismaMock.food_order.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { food_order_id: 123 },
      data: expect.objectContaining({
	        total_amount: 12.76,
	        delivery_fee: 3,
	        platform_fee: 0.64,
        order_status: 'confirmed',
        ispaid: true,
      }),
    }));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/Falling back to delivery fee/i));
    warnSpy.mockRestore();
  });

  it('does not put the self-pickup sentinel on the buyer card receipt', async () => {
    const order = {
      food_order_id: 123,
      user_id: 42,
      deliver_location: '__SELF_PICKUP__',
      fulfillment_mode: 'pickup',
      delivery_fee: 0,
      tip_amount: 4,
      promo_discount: 0,
      user: { user_id: 42, country: 'Canada', currency: 'CAD', email: 'buyer@example.test' },
      food_vendor: {
        vendor_id: 5,
        owner_id: 77,
        location: '10 Market St',
        user: { user_id: 77, email: 'vendor@example.test', country: 'Canada' },
      },
      food_order_items: [
        { qty: 2, price_item: 4, food_item: { name: 'Milk' } },
      ],
    };
    prismaMock.food_order.findUnique.mockResolvedValue(order);
    prismaMock.food_order.update.mockResolvedValue({
      ...order,
      total_amount: 9.76,
      delivery_fee: 0,
      platform_fee: 0.64,
      tip_amount: 0,
      order_status: 'confirmed',
      ispaid: true,
    });
    stripeRetrieve.mockResolvedValue({
      id: 'pi_pickup',
      status: 'succeeded',
      amount: 976,
      amount_received: 976,
      metadata: { user_id: '42', order_id: '123' },
    });

    const res = await request(app)
      .patch('/food/orders/123/checkout')
      .send({ transaction_id: 'pi_pickup', payment_method: 'CARD' });

    expect(res.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledWith(
      'food-order-receipt',
      expect.objectContaining({ delivery_location: null, isVendor: false }),
      'buyer@example.test',
      expect.any(String),
      expect.anything(),
    );
  });
});

describe('GET /food/vendors/filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not hide legitimate vendors by name text', async () => {
    prismaMock.vendor_type.findMany.mockResolvedValue([
      { vendor_type_id: 1, vendor_type: 'Restaurant' },
    ]);
    prismaMock.food_vendor.findMany.mockResolvedValue([
      { vendor_id: 1, vendor_name: 'Test Kitchen', cuisine_type: 'Food', location: 'Toronto', is_open: true, is_active: true },
      { vendor_id: 2, vendor_name: 'Downtown Market', cuisine_type: 'Grocery', location: 'Toronto', is_open: true, is_active: true },
    ]);
    prismaMock.food_order_rating.groupBy.mockResolvedValue([]);
    prismaMock.promotion.findMany.mockResolvedValue([]);

    const res = await request(app).get('/food/vendors/filter?type=FOOD');

    expect(res.status).toBe(200);
    expect(prismaMock.vendor_type.findMany).toHaveBeenCalled();
    expect(res.body.count).toBe(2);
    expect(res.body.data).toEqual([
      expect.objectContaining({ vendor_id: 1, vendor_name: 'Test Kitchen' }),
      expect.objectContaining({ vendor_id: 2, vendor_name: 'Downtown Market' }),
    ]);
  });

  it('does not apply courier radius to catering vendors', async () => {
    prismaMock.vendor_type.findMany.mockResolvedValue([
      { vendor_type_id: 5, vendor_type: 'Catering' },
    ]);
    prismaMock.food_vendor.findMany.mockResolvedValue([
      { vendor_id: 9, vendor_name: 'Far Caterer', lat: 10, long: 10, is_open: true, is_active: true },
    ]);
    prismaMock.food_order_rating.groupBy.mockResolvedValue([]);
    prismaMock.promotion.findMany.mockResolvedValue([]);

    const res = await request(app).get('/food/vendors/filter?type=Catering&lat=43.65&lng=-79.38');

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.data[0]).toEqual(expect.objectContaining({ vendor_id: 9, vendor_name: 'Far Caterer' }));
  });
});

describe('food item inventory writes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('preserves explicit stock_qty 0 when a grocery seller creates an out-of-stock item', async () => {
    prismaMock.food_category.findUnique.mockResolvedValue({
      food_category_id: 12,
      vendor_id: 5,
      name: 'Dairy',
    });
    prismaMock.food_item.create.mockResolvedValue({ food_item_id: 44, name: 'Milk', stock_qty: 0 });
    prismaMock.food_item.findUnique.mockResolvedValue({ food_item_id: 44, name: 'Milk', stock_qty: 0, food_item_pics: [] });

    const res = await request(app)
      .post('/food/items')
      .send({
        vendor_id: 5,
        vendor_type_id: 9,
        food_category_id: 12,
        name: 'Milk',
        price: 0,
        stock_qty: 0,
        is_available: false,
      });

    expect(res.status).toBe(201);
    expect(prismaMock.food_category.findUnique).toHaveBeenCalledWith({
      where: { food_category_id: 12 },
    });
    expect(prismaMock.food_item.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        food_category_id: 12,
        price: 0,
        stock_qty: 0,
        is_available: false,
      }),
    }));
  });

  it('exports vendor inventory as formula-safe CSV with threshold and expiry fields', async () => {
    prismaMock.food_vendor.findUnique.mockResolvedValue({ vendor_id: 5, owner_id: 42, vendor_type_id: 9 });
    prismaMock.food_item.findMany.mockResolvedValue([
      {
        food_item_id: 44,
        name: '=SUM(A1:A2)',
        description: 'Fresh dairy',
        price: 4.5,
        food_category_id: 12,
        is_available: true,
        stock_qty: 3,
        low_stock_threshold: 5,
        expiry_date: new Date('2026-09-07T00:00:00.000Z'),
        allergen_info: 'milk',
        food_item_pics: [{ url: 'https://cdn.example/milk.jpg' }],
      },
    ]);

    const res = await request(app).get('/food/vendor/5/items/export.csv');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('low_stock_threshold,expiry_date');
    expect(res.text).toContain("'=SUM(A1:A2)");
    expect(res.text).toContain('2026-09-07');
  });

  it('imports vendor inventory CSV atomically with threshold and expiry fields', async () => {
    prismaMock.food_vendor.findUnique.mockResolvedValue({ vendor_id: 5, owner_id: 42, vendor_type_id: 9 });
    prismaMock.food_item.findMany.mockResolvedValue([]);
    prismaMock.food_item.create.mockResolvedValue({ food_item_id: 45 });
    prismaMock.food_item_pics.create.mockResolvedValue({});
    prismaMock.$transaction.mockImplementation((fn) => fn(prismaMock));

    const csv = [
      'name,description,price,food_category_id,is_available,stock_qty,low_stock_threshold,expiry_date,allergen_info,image_url',
      'Yogurt,Plain yogurt,3.25,,true,4,6,2026-09-08,milk,https://cdn.example/yogurt.jpg',
    ].join('\n');

    const res = await request(app)
      .post('/food/vendor/5/items/import.csv')
      .attach('file', Buffer.from(csv), { filename: 'inventory.csv', contentType: 'text/csv' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ created: 1, updated: 0 });
    expect(prismaMock.food_item.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        name: 'Yogurt',
        price: 3.25,
        stock_qty: 4,
        low_stock_threshold: 6,
        expiry_date: new Date('2026-09-08T00:00:00.000Z'),
      }),
    }));
    expect(prismaMock.food_item_pics.create).toHaveBeenCalled();
  });

  it('rejects invalid inventory CSV without writing partial rows', async () => {
    prismaMock.food_vendor.findUnique.mockResolvedValue({ vendor_id: 5, owner_id: 42, vendor_type_id: 9 });

    const csv = [
      'name,price,stock_qty,expiry_date',
      'Good Item,2.50,4,2026-09-08',
      'Broken Item,,2,not-a-date',
    ].join('\n');

    const res = await request(app)
      .post('/food/vendor/5/items/import.csv')
      .attach('file', Buffer.from(csv), { filename: 'inventory.csv', contentType: 'text/csv' });

    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ row: 3 }),
    ]));
    expect(prismaMock.food_item.create).not.toHaveBeenCalled();
    expect(prismaMock.food_item.update).not.toHaveBeenCalled();
  });

  it('returns reorder suggestions from completed sales and current stock', async () => {
    prismaMock.food_vendor.findUnique.mockResolvedValue({ vendor_id: 5, owner_id: 42, vendor_type_id: 9 });
    prismaMock.food_item.findMany.mockResolvedValue([
      {
        food_item_id: 44,
        name: 'Milk',
        is_available: true,
        stock_qty: 2,
        low_stock_threshold: 3,
        expiry_date: null,
      },
    ]);
    prismaMock.food_order_items.groupBy.mockResolvedValue([
      { food_item_id: 44, _sum: { qty: 14 } },
    ]);

    const res = await request(app).get('/food/vendor/5/reorder-suggestions?days=14&coverage_days=7');

    expect(res.status).toBe(200);
    expect(res.body.data.suggestions[0]).toEqual(expect.objectContaining({
      food_item_id: 44,
      sold_qty: 14,
      avg_daily_sales: 1,
      target_stock: 10,
      suggested_reorder_qty: 8,
    }));
    expect(prismaMock.food_order_items.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      by: ['food_item_id'],
      where: expect.objectContaining({
        food_order: expect.objectContaining({
          vendor_id: 5,
          order_status: { in: ['delivered', 'completed', 'reconciled'] },
        }),
      }),
    }));
  });

  it('creates and removes vendor closure windows for the owning seller', async () => {
    prismaMock.food_vendor.findUnique.mockResolvedValue({ vendor_id: 5, owner_id: 42, vendor_type_id: 9 });
    prismaMock.food_vendor_closure.create.mockResolvedValue({
      closure_id: 9,
      vendor_id: 5,
      starts_at: new Date('2026-12-24T10:00:00.000Z'),
      ends_at: new Date('2026-12-26T10:00:00.000Z'),
      reason: 'Holiday',
      is_active: true,
    });
    prismaMock.food_vendor_closure.updateMany.mockResolvedValue({ count: 1 });

    const created = await request(app)
      .post('/food/vendor/5/closures')
      .send({
        starts_at: '2026-12-24T10:00:00.000Z',
        ends_at: '2026-12-26T10:00:00.000Z',
        reason: 'Holiday',
      });

    expect(created.status).toBe(201);
    expect(prismaMock.food_vendor_closure.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ vendor_id: 5, reason: 'Holiday', is_active: true }),
    }));

    const removed = await request(app).delete('/food/vendor/5/closures/9');
    expect(removed.status).toBe(200);
    expect(prismaMock.food_vendor_closure.updateMany).toHaveBeenCalledWith({
      where: { closure_id: 9, vendor_id: 5 },
      data: { is_active: false },
    });
  });

  it('normalizes string booleans when updating closure windows', async () => {
    prismaMock.food_vendor.findUnique.mockResolvedValue({ vendor_id: 5, owner_id: 42, vendor_type_id: 9 });
    prismaMock.food_vendor_closure.findFirst.mockResolvedValue({
      closure_id: 9,
      vendor_id: 5,
      starts_at: new Date('2026-12-24T10:00:00.000Z'),
      ends_at: new Date('2026-12-26T10:00:00.000Z'),
      reason: 'Holiday',
      is_active: true,
    });
    prismaMock.food_vendor_closure.update.mockResolvedValue({
      closure_id: 9,
      vendor_id: 5,
      is_active: false,
    });

    const res = await request(app)
      .patch('/food/vendor/5/closures/9')
      .send({ is_active: 'false' });

    expect(res.status).toBe(200);
    expect(prismaMock.food_vendor_closure.update).toHaveBeenCalledWith({
      where: { closure_id: 9 },
      data: { is_active: false },
    });
  });
});
