import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    product_variation: { findUnique: vi.fn() },
    product_listing: { findUnique: vi.fn(), update: vi.fn() },
    product_order: { create: vi.fn(), update: vi.fn() },
    stripe_orphan_payment: { findUnique: vi.fn(), update: vi.fn() },
  },
}));
vi.mock('../../utils/product-order-email.js', () => ({
  loadOrderForEmail: vi.fn(async (id) => ({ order_id: id })),
  queueShopOrderPlacedEmails: vi.fn(),
  queueDigitalDeliveryEmail: vi.fn(),
  isDigitalOrder: vi.fn(() => false),
  queueShopOrderStatusEmail: vi.fn(),
}));
vi.mock('../../middleware/authentication.js', () => ({
  authenticateToken: (req, _res, next) => { req.user = { user_id: 42, name: 'Buyer' }; next(); },
  optionalAuth: (req, _res, next) => { req.user = { user_id: 42 }; next(); },
}));

import prisma from '../../utils/prisma-client.js';
import { queueShopOrderPlacedEmails } from '../../utils/product-order-email.js';
import router from '../../routes/product-order-routes.js';

const app = express();
app.use(express.json());
app.use('/product-order', router);

const variationFixture = (overrides = {}) => ({
  variation_id: 7,
  price: 50,
  discount_pct: null,
  product_listing: {
    listing_id: 55,
    seller_id: 1000,
    availability: 10,
    seller: {
      user_id: 1000,
      storeProfile: { is_active: true, is_open: true },
    },
    ...overrides.product_listing,
  },
  ...overrides,
});

describe('POST /product-order — seller-spoof & unpaid-email guards', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects an order with no variation_id (400) and never creates a row', async () => {
    const res = await request(app)
      .post('/product-order')
      .send({ seller_id: 999, total: 400, payment_method: 'CARD' });
    expect(res.status).toBe(400);
    expect(prisma.product_order.create).not.toHaveBeenCalled();
    expect(queueShopOrderPlacedEmails).not.toHaveBeenCalled();
  });

  it('404s when the variation does not exist', async () => {
    prisma.product_variation.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .post('/product-order')
      .send({ variation_id: 123, payment_method: 'CARD' });
    expect(res.status).toBe(404);
  });

  it('derives seller from the listing (ignoring a spoofed body seller_id) and server-prices the total', async () => {
    prisma.product_variation.findUnique.mockResolvedValue(variationFixture());
    prisma.product_order.create.mockResolvedValue({ order_id: 1, ispaid: false });

    const res = await request(app)
      .post('/product-order')
      .send({ variation_id: 7, qty: 2, seller_id: 999, total: 99999, payment_method: 'CARD' });

    expect(res.status).toBe(201);
    const data = prisma.product_order.create.mock.calls[0][0].data;
    expect(data.seller_id).toBe(1000);   // listing owner, NOT the body's 999
    expect(data.total).toBe(100);        // server-priced 50×2, NOT the client's 99999
    // unpaid card order → no "prepare and ship" email at creation
    expect(queueShopOrderPlacedEmails).not.toHaveBeenCalled();
  });

  it('emails buyer + seller immediately for a settled (non-card) order', async () => {
    prisma.product_variation.findUnique.mockResolvedValue(variationFixture());
    prisma.product_order.create.mockResolvedValue({ order_id: 5, ispaid: true });
    prisma.stripe_orphan_payment.findUnique.mockResolvedValue(null);
    prisma.product_listing.findUnique.mockResolvedValue({ listing_id: 55, availability: 10 });
    prisma.product_listing.update.mockResolvedValue({ listing_id: 55, availability: 9 });

    const res = await request(app)
      .post('/product-order')
      .send({ variation_id: 7, qty: 1, payment_method: 'WALLET' });

    expect(res.status).toBe(201);
    expect(queueShopOrderPlacedEmails).toHaveBeenCalledTimes(1);
    expect(prisma.product_listing.update).toHaveBeenCalledWith({
      where: { listing_id: 55 },
      data: { availability: 9 },
    });
  });

  it('409s when the store is temporarily closed', async () => {
    prisma.product_variation.findUnique.mockResolvedValue(variationFixture({
      product_listing: {
        listing_id: 55,
        seller_id: 1000,
        availability: 10,
        seller: {
          user_id: 1000,
          storeProfile: { is_active: true, is_open: false },
        },
      },
    }));

    const res = await request(app)
      .post('/product-order')
      .send({ variation_id: 7, qty: 1, payment_method: 'WALLET' });

    expect(res.status).toBe(409);
    expect(prisma.product_order.create).not.toHaveBeenCalled();
  });

  it('409s when stock is insufficient', async () => {
    prisma.product_variation.findUnique.mockResolvedValue(variationFixture({
      product_listing: {
        listing_id: 55,
        seller_id: 1000,
        availability: 1,
        seller: {
          user_id: 1000,
          storeProfile: { is_active: true, is_open: true },
        },
      },
    }));

    const res = await request(app)
      .post('/product-order')
      .send({ variation_id: 7, qty: 3, payment_method: 'WALLET' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/stock/i);
    expect(prisma.product_order.create).not.toHaveBeenCalled();
  });
});
