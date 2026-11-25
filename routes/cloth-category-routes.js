import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/**
 * Get all cloth categories
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const categories = await prisma.cloth_category.findMany({
      orderBy: { cloth_category_id: 'asc' },
      include: {
        cloth: true,
      },
    });

    res.json(categories);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch cloth categories' });
  }
});

/**
 * Get single cloth category
 */
router.get('/:cloth_category_id', authenticateToken, async (req, res) => {
  try {
    const category = await prisma.cloth_category.findUnique({
      where: {
        cloth_category_id: Number(req.params.cloth_category_id),
      },
      include: {
        cloth: true,
      },
    });

    if (!category)
      return res.status(404).json({ error: 'Cloth category not found' });

    res.json(category);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch cloth category' });
  }
});

/**
 * Create cloth category
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { cloth_category_name } = req.body;

    if (!cloth_category_name) {
      return res.status(400).json({
        error: 'cloth_category_name is required',
      });
    }

    const newCategory = await prisma.cloth_category.create({
      data: {
        cloth_category_name,
      },
    });

    io?.emit('cloth-category-created', newCategory);

    res.status(201).json(newCategory);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create cloth category' });
  }
});

/**
 * Update cloth category
 */
router.put('/:cloth_category_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { cloth_category_id } = req.params;
    const { cloth_category_name } = req.body;

    const existing = await prisma.cloth_category.findUnique({
      where: {
        cloth_category_id: Number(cloth_category_id),
      },
    });

    if (!existing)
      return res.status(404).json({ error: 'Cloth category not found' });

    const updatedCategory = await prisma.cloth_category.update({
      where: {
        cloth_category_id: Number(cloth_category_id),
      },
      data: {
        cloth_category_name,
      },
    });

    io?.emit('cloth-category-updated', updatedCategory);

    res.json(updatedCategory);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update cloth category' });
  }
});

/**
 * Delete cloth category
 */
router.delete('/:cloth_category_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const deleted = await prisma.cloth_category.delete({
      where: {
        cloth_category_id: Number(req.params.cloth_category_id),
      },
    });

    io?.emit('cloth-category-deleted', {
      cloth_category_id: deleted.cloth_category_id,
    });

    res.json({ message: 'Cloth category deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete cloth category' });
  }
});

export default router;
