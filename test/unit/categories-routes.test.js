import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import router from '../../routes/categories-routes.js';
import prisma from '../../utils/prisma-client.js';
import redis from '../../utils/redis-client.js';

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    categories: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn()
    },
    video: {
      count: vi.fn(),
      updateMany: vi.fn()
    },
    $transaction: vi.fn()
  }
}));

vi.mock('../../utils/redis-client.js', () => ({
  default: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn()
  }
}));

vi.mock('../../middleware/authentication.js', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { user_id: 1, role: 'ADMIN' };
    next();
  },
  requireAdmin: (req, res, next) => {
    next();
  }
}));

const app = express();
app.use(express.json());
app.use('/categories', router);

describe('Category API Routes Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should fetch categories from cache if available', async () => {
    const mockCategories = [
      { category_id: 1, category_name: 'Tech' },
      { category_id: 2, category_name: 'Gaming' }
    ];
    redis.get.mockResolvedValue(JSON.stringify(mockCategories));

    const res = await request(app).get('/categories');

    expect(res.status).toBe(200);
    expect(res.body.successful).toBe(true);
    expect(res.body.data).toEqual(mockCategories);
    expect(prisma.categories.findMany).not.toHaveBeenCalled();
  });

  it('should fetch categories from DB and set cache if not cached', async () => {
    const mockCategories = [
      { category_id: 1, category_name: 'Tech' }
    ];
    redis.get.mockResolvedValue(null);
    prisma.categories.findMany.mockResolvedValue(mockCategories);

    const res = await request(app).get('/categories');

    expect(res.status).toBe(200);
    expect(res.body.successful).toBe(true);
    expect(res.body.data).toEqual(mockCategories);
    expect(prisma.categories.findMany).toHaveBeenCalled();
    expect(redis.set).toHaveBeenCalledWith('categories:all', JSON.stringify(mockCategories), 'EX', 86400);
  });

  it('should return 400 if category creation name is too short', async () => {
    const res = await request(app)
      .post('/categories')
      .send({ category_name: 'Hi' });

    expect(res.status).toBe(400);
    expect(res.body.successful).toBe(false);
  });

  it('should create new category and clear cache on valid input', async () => {
    const newCategory = { category_id: 3, category_name: 'Education' };
    prisma.categories.findFirst.mockResolvedValue(null);
    prisma.categories.create.mockResolvedValue(newCategory);

    const res = await request(app)
      .post('/categories')
      .send({ category_name: 'Education' });

    expect(res.status).toBe(201);
    expect(res.body.successful).toBe(true);
    expect(res.body.data).toEqual(newCategory);
    expect(redis.del).toHaveBeenCalledWith('categories:all');
  });

  it('should perform safe data migration transaction on category deletion', async () => {
    prisma.categories.findUnique.mockResolvedValue({ category_id: 2, category_name: 'Gaming' });
    prisma.$transaction.mockImplementation(async (callback) => {
      const tx = {
        video: { updateMany: vi.fn() },
        categories: { delete: vi.fn() }
      };
      await callback(tx);
      expect(tx.video.updateMany).toHaveBeenCalledWith({
        where: { category: 'Gaming' },
        data: { category: 'General' }
      });
      expect(tx.categories.delete).toHaveBeenCalledWith({
        where: { category_id: 2 }
          });
        });

        const res = await request(app).delete('/categories/2');

        expect(res.status).toBe(200);
        expect(res.body.successful).toBe(true);
        expect(redis.del).toHaveBeenCalledWith('categories:all');
      });
    });