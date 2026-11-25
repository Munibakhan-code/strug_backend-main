// routes/calmCategory.js
import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/**
 * Get all calm categories
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const categories = await prisma.calm_category.findMany({
      orderBy: { calm_category_id: 'asc' },
      include: {
        calm_providers: true,
      },
    });

    res.json(categories);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch calm categories' });
  }
});

/**
 * Get single calm category
 */
router.get('/:calm_category_id', authenticateToken, async (req, res) => {
  try {
    const category = await prisma.calm_category.findUnique({
      where: { calm_category_id: Number(req.params.calm_category_id) },
      include: {
        calm_providers: true,
      },
    });

    if (!category) return res.status(404).json({ error: 'Calm category not found' });

    res.json(category);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch calm category' });
  }
});

/**
 * Create new calm category
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { calm_category_name } = req.body;

    if (!calm_category_name) {
      return res.status(400).json({ error: 'calm_category_name is required' });
    }

    const newCategory = await prisma.calm_category.create({
      data: {
        calm_category_name,
      },
    });

    io?.emit('calm-category-created', newCategory);

    res.status(201).json(newCategory);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create calm category' });
  }
});

/**
 * Update calm category
 */
router.put('/:calm_category_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { calm_category_id } = req.params;
    const { calm_category_name } = req.body;

    const existing = await prisma.calm_category.findUnique({
      where: { calm_category_id: Number(calm_category_id) },
    });

    if (!existing) return res.status(404).json({ error: 'Calm category not found' });

    const updatedCategory = await prisma.calm_category.update({
      where: { calm_category_id: Number(calm_category_id) },
      data: {
        calm_category_name: calm_category_name ?? existing.calm_category_name,
      },
    });

    io?.emit('calm-category-updated', updatedCategory);

    res.json(updatedCategory);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update calm category' });
  }
});

/**
 * Delete calm category
 */
router.delete('/:calm_category_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const deleted = await prisma.calm_category.delete({
      where: { calm_category_id: Number(req.params.calm_category_id) },
    });

    io?.emit('calm-category-deleted', { calm_category_id: deleted.calm_category_id });

    res.json({ message: 'Calm category deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete calm category' });
  }
});

export default router;