/**
 * Paid DG order must not be mutated after payment (#1298 review).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const authUser = { current: { user_id: 42, role: 'USER' } };

vi.mock('../../middleware/authentication.js', () => ({
  authenticateToken: (req, res, next) => {
    if (!authUser.current) return res.status(401).json({ message: 'Unauthorized' });
    req.user = { ...authUser.current };
    next();
  },
}));

const prismaMock = {
  dg_order: {
    findUnique: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  dg_content: {
    findUnique: vi.fn(),
  },
};

vi.mock('../../utils/prisma-client.js', () => ({ default: prismaMock }));

const dgOrderRouter = (await import('../../routes/dg-order-routes.js')).default;

function app() {
  const a = express();
  a.use(express.json());
  a.use('/dg-order', dgOrderRouter);
  return a;
}

beforeEach(() => {
  authUser.current = { user_id: 42, role: 'USER' };
  vi.clearAllMocks();
});

describe('PUT /dg-order/:order_id paid lock', () => {
  it('401 unauthenticated', async () => {
    authUser.current = null;
    expect((await request(app()).put('/dg-order/1').send({ qty: 2 })).status).toBe(401);
  });

  it('403 cross-buyer', async () => {
    prismaMock.dg_order.findUnique.mockResolvedValue({
      order_id: 1,
      buyer_id: 99,
      ispaid: false,
      content_id: 5,
      qty: 1,
      total: 10,
    });
    expect((await request(app()).put('/dg-order/1').send({ qty: 9 })).status).toBe(403);
  });

  it('400 when order is already paid (cannot swap content)', async () => {
    prismaMock.dg_order.findUnique.mockResolvedValue({
      order_id: 1,
      buyer_id: 42,
      ispaid: true,
      content_id: 5,
      qty: 1,
      total: 10,
    });
    const res = await request(app()).put('/dg-order/1').send({ content_id: 99, qty: 1 });
    expect(res.status).toBe(400);
    expect(prismaMock.dg_order.update).not.toHaveBeenCalled();
    expect(prismaMock.dg_content.findUnique).not.toHaveBeenCalled();
  });

  it('updates unpaid order with catalog total', async () => {
    prismaMock.dg_order.findUnique.mockResolvedValue({
      order_id: 1,
      buyer_id: 42,
      ispaid: false,
      content_id: 5,
      qty: 1,
      total: 10,
      date: null,
      payment_method: null,
      expire_date: null,
      dg_category_id: null,
      checkout_id: null,
    });
    prismaMock.dg_content.findUnique.mockResolvedValue({ price: 25, dg_category_id: 2 });
    prismaMock.dg_order.update.mockResolvedValue({ order_id: 1, total: 50, qty: 2 });
    const res = await request(app()).put('/dg-order/1').send({ qty: 2 });
    expect(res.status).toBe(200);
    expect(prismaMock.dg_order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ total: 50, qty: 2 }),
      }),
    );
  });
});
