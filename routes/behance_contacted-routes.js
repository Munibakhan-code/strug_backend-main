// routes/behanceContacted.js
import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/**
 * Get all behance contacted records
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const records = await prisma.behance_contacted.findMany({
      orderBy: { contacted_id: 'desc' },
      include: {
        behance: true,
        social_feed: true,
      },
    });
    res.json(records);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch behance contacted records' });
  }
});

/**
 * Get single behance contacted record
 */
router.get('/:contacted_id', authenticateToken, async (req, res) => {
  try {
    const record = await prisma.behance_contacted.findUnique({
      where: { contacted_id: Number(req.params.contacted_id) },
      include: {
        behance: true,
        social_feed: true,
      },
    });
    if (!record) return res.status(404).json({ error: 'Behance contacted record not found' });
    res.json(record);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch behance contacted record' });
  }
});

/**
 * Create behance contacted record
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const { behance_id, social_post_id, content, contacted_date } = req.body;
    if (!behance_id || !content) {
      return res.status(400).json({ error: 'behance_id and content are required' });
    }
    const newRecord = await prisma.behance_contacted.create({
      data: {
        behance_id: Number(behance_id),
        social_post_id: social_post_id ? Number(social_post_id) : null,
        content,
        contacted_date: contacted_date ? new Date(contacted_date) : new Date(),
      },
    });
    io?.emit('behance-contacted-created', newRecord);
    res.status(201).json(newRecord);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create behance contacted record' });
  }
});

/**
 * Update behance contacted record
 */
router.put('/:contacted_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const { contacted_id } = req.params;
    const { behance_id, social_post_id, content, contacted_date } = req.body;
    const existing = await prisma.behance_contacted.findUnique({
      where: { contacted_id: Number(contacted_id) },
    });
    if (!existing) return res.status(404).json({ error: 'Behance contacted record not found' });
    const updated = await prisma.behance_contacted.update({
      where: { contacted_id: Number(contacted_id) },
      data: {
        behance_id: behance_id ? Number(behance_id) : existing.behance_id,
        social_post_id: social_post_id ? Number(social_post_id) : existing.social_post_id,
        content: content ?? existing.content,
        contacted_date: contacted_date ? new Date(contacted_date) : existing.contacted_date,
      },
    });
    io?.emit('behance-contacted-updated', updated);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update behance contacted record' });
  }
});

/**
 * Delete behance contacted record
 */
router.delete('/:contacted_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const deleted = await prisma.behance_contacted.delete({
      where: { contacted_id: Number(req.params.contacted_id) },
    });
    io?.emit('behance-contacted-deleted', { contacted_id: deleted.contacted_id });
    res.json({ message: 'Behance contacted record deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete behance contacted record' });
  }
});

export default router;