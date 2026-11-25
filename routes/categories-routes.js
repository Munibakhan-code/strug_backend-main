import express from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma-client.js';
import redis from '../utils/redis-client.js';
import { authenticateToken, requireAdmin } from '../middleware/authentication.js';
import { visibleVideoWhere } from '../utils/video-visibility.js';

const router = express.Router();

const categorySchema = z.object({
  category_name: z.string().min(3).max(120)
});

router.get('/', authenticateToken, async (req, res, next) => {
  try {
    const cached = await redis.get('categories:all');
    if (cached) {
      return res.json({ successful: true, data: JSON.parse(cached) });
    }

    const list = await prisma.categories.findMany({
      orderBy: { category_id: 'asc' }
    });

    await redis.set('categories:all', JSON.stringify(list), 'EX', 86400);

    return res.json({ successful: true, data: list });
  } catch (err) {
    next(err);
  }
});

router.get('/:category_id', authenticateToken, async (req, res, next) => {
  try {
    const categoryId = Number(req.params.category_id);
    if (Number.isNaN(categoryId)) {
      return res.status(400).json({ successful: false, message: 'Invalid category ID' });
    }

    const category = await prisma.categories.findUnique({
      where: { category_id: categoryId }
    });

    if (!category) {
      return res.status(404).json({ successful: false, message: 'Category not found' });
    }

    // Must match what the category rail will actually RENDER, or the badge promises videos the
    // listing then filters away (it previously counted every 'safe' row, including ones still
    // processing or from an inactive channel).
    const videoCount = await prisma.video.count({
      where: visibleVideoWhere({ category: category.category_name })
    });

    return res.json({ successful: true, data: { ...category, video_count: videoCount } });
  } catch (err) {
    next(err);
  }
});

router.post('/', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const validated = categorySchema.parse(req.body);

    const existing = await prisma.categories.findFirst({
      where: { category_name: { equals: validated.category_name, mode: 'insensitive' } }
    });

    if (existing) {
      return res.status(400).json({ successful: false, message: 'Category name already exists' });
    }

    const created = await prisma.categories.create({
      data: { category_name: validated.category_name }
    });

    await redis.del('categories:all');

    const io = req.app.get('io');
    io?.emit('category-created', created);

    return res.status(201).json({ successful: true, data: created });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    next(err);
  }
});

router.put('/:category_id', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const categoryId = Number(req.params.category_id);
    if (Number.isNaN(categoryId)) {
      return res.status(400).json({ successful: false, message: 'Invalid category ID' });
    }

    const validated = categorySchema.parse(req.body);

    const existing = await prisma.categories.findUnique({
      where: { category_id: categoryId }
    });

    if (!existing) {
      return res.status(404).json({ successful: false, message: 'Category not found' });
    }

    const duplicate = await prisma.categories.findFirst({
      where: {
        category_name: { equals: validated.category_name, mode: 'insensitive' },
        category_id: { not: categoryId }
      }
    });

    if (duplicate) {
      return res.status(400).json({ successful: false, message: 'Category name already exists' });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.categories.update({
        where: { category_id: categoryId },
        data: { category_name: validated.category_name }
      });

      await tx.video.updateMany({
        where: { category: existing.category_name },
        data: { category: validated.category_name }
      });

      return result;
    });

    await redis.del('categories:all');

    const io = req.app.get('io');
    io?.emit('category-updated', updated);

    return res.json({ successful: true, data: updated });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    next(err);
  }
});

router.delete('/:category_id', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const categoryId = Number(req.params.category_id);
    if (Number.isNaN(categoryId)) {
      return res.status(400).json({ successful: false, message: 'Invalid category ID' });
    }

    const existing = await prisma.categories.findUnique({
      where: { category_id: categoryId }
    });

    if (!existing) {
      return res.status(404).json({ successful: false, message: 'Category not found' });
    }

    await prisma.$transaction(async (tx) => {
      await tx.video.updateMany({
        where: { category: existing.category_name },
        data: { category: 'General' }
      });

      await tx.categories.delete({
        where: { category_id: categoryId }
      });
    });

    await redis.del('categories:all');

    const io = req.app.get('io');
    io?.emit('category-deleted', { category_id: categoryId });

    return res.json({ successful: true });
  } catch (err) {
    next(err);
  }
});

// NOTE: a second PUT/DELETE '/:category_id' pair used to live here, operating on
// `live_stream_category`. Express matches the FIRST registration, so the routes above
// always won and that block was unreachable — it referenced `categoryUpdateSchema`, `xss`
// and `REDIS_CACHE_KEY`, none of which are defined in this module. Live stream categories
// already have full CRUD at /stream-category (routes/stream-category-routes.js), so the
// dead block was removed rather than repaired.

export default router;
