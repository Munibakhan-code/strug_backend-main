import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/**
 * Get all CS categories
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const categories = await prisma.cs_categories.findMany({
      orderBy: { cs_category_id: 'asc' },
      include: {
        cs_type: true,
        cs_content: true,
      },
    });

    res.json(categories);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch CS categories' });
  }
});

/**
 * Get single CS category
 */
router.get('/:cs_category_id', authenticateToken, async (req, res) => {
  try {
    const category = await prisma.cs_categories.findUnique({
      where: { cs_category_id: Number(req.params.cs_category_id) },
      include: {
        cs_type: true,
        cs_content: true,
      },
    });

    if (!category)
      return res.status(404).json({ error: 'CS category not found' });

    res.json(category);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch CS category' });
  }
});

/**
 * Create CS category
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { cs_category_name, cs_type_id } = req.body;

    if (!cs_category_name) {
      return res.status(400).json({ error: 'cs_category_name is required' });
    }

    const newCategory = await prisma.cs_categories.create({
      data: {
        cs_category_name,
        cs_type_id,
      },
    });

    io?.emit('cs-category-created', newCategory);

    res.status(201).json(newCategory);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create CS category' });
  }
});

/**
 * Update CS category
 */
router.put('/:cs_category_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { cs_category_id } = req.params;
    const { cs_category_name, cs_type_id } = req.body;

    const existing = await prisma.cs_categories.findUnique({
      where: { cs_category_id: Number(cs_category_id) },
    });

    if (!existing)
      return res.status(404).json({ error: 'CS category not found' });

    const updatedCategory = await prisma.cs_categories.update({
      where: { cs_category_id: Number(cs_category_id) },
      data: {
        cs_category_name,
        cs_type_id,
      },
    });

    io?.emit('cs-category-updated', updatedCategory);

    res.json(updatedCategory);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update CS category' });
  }
});

/**
 * Delete CS category
 */
router.delete('/:cs_category_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const deleted = await prisma.cs_categories.delete({
      where: { cs_category_id: Number(req.params.cs_category_id) },
    });

    io?.emit('cs-category-deleted', { cs_category_id: deleted.cs_category_id });

    res.json({ message: 'CS category deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete CS category' });
  }
});

export default router;
