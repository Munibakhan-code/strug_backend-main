// routes/behance.js
import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/**
 * Get all behance profiles
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const profiles = await prisma.behance.findMany({
      orderBy: { behance_id: 'desc' },
      include: { user: true },
    });
    res.json(profiles);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch behance profiles' });
  }
});

/**
 * Get single behance profile
 */
router.get('/:behance_id', authenticateToken, async (req, res) => {
  try {
    const profile = await prisma.behance.findUnique({
      where: { behance_id: Number(req.params.behance_id) },
      include: { user: true },
    });
    if (!profile) return res.status(404).json({ error: 'Behance profile not found' });
    res.json(profile);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch behance profile' });
  }
});

/**
 * Create behance profile
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const { behance_user_id, is_hireable } = req.body;
    if (!behance_user_id) {
      return res.status(400).json({ error: 'behance_user_id is required' });
    }
    const newProfile = await prisma.behance.create({
      data: {
        behance_user_id: Number(behance_user_id),
        is_hireable: is_hireable ?? false,
      },
    });
    io?.emit('behance-created', newProfile);
    res.status(201).json(newProfile);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create behance profile' });
  }
});

/**
 * Update behance profile
 */
router.put('/:behance_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const { behance_id } = req.params;
    const { behance_user_id, is_hireable } = req.body;
    const existing = await prisma.behance.findUnique({
      where: { behance_id: Number(behance_id) },
    });
    if (!existing) return res.status(404).json({ error: 'Behance profile not found' });
    const updated = await prisma.behance.update({
      where: { behance_id: Number(behance_id) },
      data: {
        behance_user_id: behance_user_id ? Number(behance_user_id) : existing.behance_user_id,
        is_hireable: is_hireable ?? existing.is_hireable,
      },
    });
    io?.emit('behance-updated', updated);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update behance profile' });
  }
});

/**
 * Delete behance profile
 */
router.delete('/:behance_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const deleted = await prisma.behance.delete({
      where: { behance_id: Number(req.params.behance_id) },
    });
    io?.emit('behance-deleted', { behance_id: deleted.behance_id });
    res.json({ message: 'Behance profile deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete behance profile' });
  }
});

export default router;