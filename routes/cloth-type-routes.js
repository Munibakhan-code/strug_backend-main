import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/**
 * Get all cloth types
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const types = await prisma.cloth_type.findMany({
      orderBy: { cloth_type_id: 'asc' },
      include: {
        cloth: true,
      },
    });

    res.json(types);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch cloth types' });
  }
});

/**
 * Get single cloth type
 */
router.get('/:cloth_type_id', authenticateToken, async (req, res) => {
  try {
    const type = await prisma.cloth_type.findUnique({
      where: {
        cloth_type_id: Number(req.params.cloth_type_id),
      },
      include: {
        cloth: true,
      },
    });

    if (!type)
      return res.status(404).json({ error: 'Cloth type not found' });

    res.json(type);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch cloth type' });
  }
});

/**
 * Create cloth type
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { cloth_type_name } = req.body;

    if (!cloth_type_name) {
      return res.status(400).json({
        error: 'cloth_type_name is required',
      });
    }

    const newType = await prisma.cloth_type.create({
      data: {
        cloth_type_name,
      },
    });

    io?.emit('cloth-type-created', newType);

    res.status(201).json(newType);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create cloth type' });
  }
});

/**
 * Update cloth type
 */
router.put('/:cloth_type_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { cloth_type_id } = req.params;
    const { cloth_type_name } = req.body;

    const existing = await prisma.cloth_type.findUnique({
      where: {
        cloth_type_id: Number(cloth_type_id),
      },
    });

    if (!existing)
      return res.status(404).json({ error: 'Cloth type not found' });

    const updatedType = await prisma.cloth_type.update({
      where: {
        cloth_type_id: Number(cloth_type_id),
      },
      data: {
        cloth_type_name,
      },
    });

    io?.emit('cloth-type-updated', updatedType);

    res.json(updatedType);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update cloth type' });
  }
});

/**
 * Delete cloth type
 */
router.delete('/:cloth_type_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const deleted = await prisma.cloth_type.delete({
      where: {
        cloth_type_id: Number(req.params.cloth_type_id),
      },
    });

    io?.emit('cloth-type-deleted', {
      cloth_type_id: deleted.cloth_type_id,
    });

    res.json({ message: 'Cloth type deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete cloth type' });
  }
});

export default router;
