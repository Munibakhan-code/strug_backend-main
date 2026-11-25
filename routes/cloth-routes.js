import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/**
 * Get all clothes
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const clothes = await prisma.cloth.findMany({
      orderBy: { cloth_id: 'desc' },
      include: {
        cloth_category: true,
        cloth_type: true,
        user: true,
      },
    });

    res.json(clothes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch clothes' });
  }
});

/**
 * Get single cloth item
 */
router.get('/:cloth_id', authenticateToken, async (req, res) => {
  try {
    const cloth = await prisma.cloth.findUnique({
      where: { cloth_id: Number(req.params.cloth_id) },
      include: {
        cloth_category: true,
        cloth_type: true,
        user: true,
      },
    });

    if (!cloth)
      return res.status(404).json({ error: 'Cloth not found' });

    res.json(cloth);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch cloth' });
  }
});

/**
 * Create cloth
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const {
      cloth_image_url,
      color,
      cloth_category_id,
      cloth_type_id,
      user_id,
    } = req.body;

    const newCloth = await prisma.cloth.create({
      data: {
        cloth_image_url,
        color,
        cloth_category_id,
        cloth_type_id,
        user_id,
      },
    });

    io?.emit('cloth-created', newCloth);

    res.status(201).json(newCloth);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create cloth' });
  }
});

/**
 * Update cloth
 */
router.put('/:cloth_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { cloth_id } = req.params;
    const {
      cloth_image_url,
      color,
      cloth_category_id,
      cloth_type_id,
    } = req.body;

    const existing = await prisma.cloth.findUnique({
      where: { cloth_id: Number(cloth_id) },
    });

    if (!existing)
      return res.status(404).json({ error: 'Cloth not found' });

    const updatedCloth = await prisma.cloth.update({
      where: { cloth_id: Number(cloth_id) },
      data: {
        cloth_image_url,
        color,
        cloth_category_id,
        cloth_type_id,
      },
    });

    io?.emit('cloth-updated', updatedCloth);

    res.json(updatedCloth);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update cloth' });
  }
});

/**
 * Delete cloth
 */
router.delete('/:cloth_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const deleted = await prisma.cloth.delete({
      where: { cloth_id: Number(req.params.cloth_id) },
    });

    io?.emit('cloth-deleted', {
      cloth_id: deleted.cloth_id,
    });

    res.json({ message: 'Cloth deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete cloth' });
  }
});

export default router;
