import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/**
 * Get all DG categories
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const categories = await prisma.dg_categories.findMany({
      orderBy: { dg_category_id: 'asc' },
      include: {
        dg_cart: true,
        dg_content: true,
        dg_order: true,
      },
    });

    res.json(categories);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch DG categories' });
  }
});

/**
 * Get single DG category
 */
router.get('/:dg_category_id', authenticateToken, async (req, res) => {
  try {
    const category = await prisma.dg_categories.findUnique({
      where: { dg_category_id: Number(req.params.dg_category_id) },
      include: {
        dg_cart: true,
        dg_content: true,
        dg_order: true,
      },
    });

    if (!category) return res.status(404).json({ error: 'DG category not found' });

    res.json(category);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch DG category' });
  }
});

/**
 * Create DG category
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { dg_category_name } = req.body;

    if (!dg_category_name) {
      return res.status(400).json({ error: 'dg_category_name is required' });
    }

    const newCategory = await prisma.dg_categories.create({
      data: {
        dg_category_name,
      },
    });

    io?.emit('dg-category-created', newCategory);

    res.status(201).json(newCategory);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create DG category' });
  }
});

/**
 * Update DG category
 */
router.put('/:dg_category_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { dg_category_id } = req.params;
    const { dg_category_name } = req.body;

    const existing = await prisma.dg_categories.findUnique({
      where: { dg_category_id: Number(dg_category_id) },
    });

    if (!existing) return res.status(404).json({ error: 'DG category not found' });

    const updatedCategory = await prisma.dg_categories.update({
      where: { dg_category_id: Number(dg_category_id) },
      data: {
        dg_category_name,
      },
    });

    io?.emit('dg-category-updated', updatedCategory);

    res.json(updatedCategory);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update DG category' });
  }
});

/**
 * Delete DG category
 */
router.delete('/:dg_category_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const deleted = await prisma.dg_categories.delete({
      where: { dg_category_id: Number(req.params.dg_category_id) },
    });

    io?.emit('dg-category-deleted', { dg_category_id: deleted.dg_category_id });

    res.json({ message: 'DG category deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete DG category' });
  }
});

export default router;
