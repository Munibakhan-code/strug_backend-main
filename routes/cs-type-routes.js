import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/**
 * Get all CS types
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const types = await prisma.cs_type.findMany({
      orderBy: { cs_type_id: 'asc' },
      include: {
        cs_categories: true,
        cs_content: true,
        user_content_subscription_mapping: true,
      },
    });

    res.json(types);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch CS types' });
  }
});

/**
 * Get single CS type
 */
router.get('/:cs_type_id', authenticateToken, async (req, res) => {
  try {
    const type = await prisma.cs_type.findUnique({
      where: { cs_type_id: Number(req.params.cs_type_id) },
      include: {
        cs_categories: true,
        cs_content: true,
        user_content_subscription_mapping: true,
      },
    });

    if (!type) return res.status(404).json({ error: 'CS type not found' });

    res.json(type);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch CS type' });
  }
});

/**
 * Create CS type
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { cs_type_name, subscription_price } = req.body;

    if (!cs_type_name) {
      return res.status(400).json({ error: 'cs_type_name is required' });
    }

    const newType = await prisma.cs_type.create({
      data: {
        cs_type_name,
        subscription_price,
      },
    });

    io?.emit('cs-type-created', newType);

    res.status(201).json(newType);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create CS type' });
  }
});

/**
 * Update CS type
 */
router.put('/:cs_type_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { cs_type_id } = req.params;
    const { cs_type_name, subscription_price } = req.body;

    const existing = await prisma.cs_type.findUnique({
      where: { cs_type_id: Number(cs_type_id) },
    });

    if (!existing) return res.status(404).json({ error: 'CS type not found' });

    const updatedType = await prisma.cs_type.update({
      where: { cs_type_id: Number(cs_type_id) },
      data: {
        cs_type_name,
        subscription_price,
      },
    });

    io?.emit('cs-type-updated', updatedType);

    res.json(updatedType);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update CS type' });
  }
});

/**
 * Delete CS type
 */
router.delete('/:cs_type_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const deleted = await prisma.cs_type.delete({
      where: { cs_type_id: Number(req.params.cs_type_id) },
    });

    io?.emit('cs-type-deleted', { cs_type_id: deleted.cs_type_id });

    res.json({ message: 'CS type deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete CS type' });
  }
});

export default router;
