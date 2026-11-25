/**
 * #1290 dg-cart: JWT buyer_id, server total, owner-scoped list/get/delete.
 * Also covers cross-account cart dump (profile / wallet attribution leak).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const authUser = { current: { user_id: 10, role: 'USER' } };

vi.mock('../../middleware/authentication.js', () => ({
  authenticateToken: (req, res, next) => {
    if (!authUser.current) return res.status(401).json({ message: 'Unauthorized' });
    req.user = { ...authUser.current };
    next();
  },
}));

const prismaMock = {
  dg_cart: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  dg_content: {
    findUnique: vi.fn(),
  },
};

vi.mock('../../utils/prisma-client.js', () => ({ default: prismaMock }));

const router = (await import('../../routes/dg-cart-routes.js')).default;

function app() {
  const a = express();
  a.use(express.json());
  a.set('io', { to: () => ({ emit: vi.fn() }) });
  a.use('/dg-cart', router);
  return a;
}

beforeEach(() => {
  authUser.current = { user_id: 10, role: 'USER' };
  vi.clearAllMocks();
});

describe('GET /dg-cart', () => {
  it('401 without auth', async () => {
    authUser.current = null;
    const res = await request(app()).get('/dg-cart');
    expect(res.status).toBe(401);
  });

  it('scopes list to JWT buyer_id (no cross-account dump)', async () => {
    prismaMock.dg_cart.findMany.mockResolvedValue([]);
    const res = await request(app()).get('/dg-cart');
    expect(res.status).toBe(200);
    expect(prismaMock.dg_cart.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { buyer_id: 10 } }),
    );
  });
});

describe('POST /dg-cart', () => {
  it('sets buyer_id from JWT and ignores client buyer_id + total', async () => {
    prismaMock.dg_content.findUnique.mockResolvedValue({ price: 12.5, dg_category_id: 3 });
    prismaMock.dg_cart.create.mockImplementation(async ({ data }) => ({ cart_id: 1, ...data }));

    const res = await request(app())
      .post('/dg-cart')
      .send({ content_id: 9, buyer_id: 999, qty: 2, total: 1 });

    expect(res.status).toBe(201);
    expect(prismaMock.dg_cart.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        buyer_id: 10,
        content_id: 9,
        qty: 2,
        total: 25,
      }),
    });
    expect(prismaMock.dg_cart.create.mock.calls[0][0].data.buyer_id).not.toBe(999);
    expect(prismaMock.dg_cart.create.mock.calls[0][0].data.total).not.toBe(1);
  });

  it('400 when content missing', async () => {
    prismaMock.dg_content.findUnique.mockResolvedValue(null);
    const res = await request(app()).post('/dg-cart').send({ content_id: 9, qty: 1 });
    expect(res.status).toBe(400);
    expect(prismaMock.dg_cart.create).not.toHaveBeenCalled();
  });
});

describe('PUT/DELETE ownership', () => {
  it('403 when updating another user cart', async () => {
    prismaMock.dg_cart.findUnique.mockResolvedValue({ cart_id: 5, buyer_id: 77, content_id: 1, qty: 1 });
    const res = await request(app()).put('/dg-cart/5').send({ qty: 3 });
    expect(res.status).toBe(403);
    expect(prismaMock.dg_cart.update).not.toHaveBeenCalled();
  });

  it('403 when deleting another user cart', async () => {
    prismaMock.dg_cart.findUnique.mockResolvedValue({ cart_id: 5, buyer_id: 77 });
    const res = await request(app()).delete('/dg-cart/5');
    expect(res.status).toBe(403);
    expect(prismaMock.dg_cart.delete).not.toHaveBeenCalled();
  });
});
