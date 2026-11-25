// routes/camPost.js
import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/**
 * Get all cam posts
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const posts = await prisma.cam_post.findMany({
      orderBy: { cam_post_id: 'desc' },
      include: {
        talent: true,
      },
    });

    res.json(posts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch cam posts' });
  }
});

/**
 * Get single cam post
 */
router.get('/:cam_post_id', authenticateToken, async (req, res) => {
  try {
    const post = await prisma.cam_post.findUnique({
      where: { cam_post_id: Number(req.params.cam_post_id) },
      include: {
        talent: true,
      },
    });

    if (!post) return res.status(404).json({ error: 'Cam post not found' });

    res.json(post);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch cam post' });
  }
});

/**
 * Create new cam post
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const {
      talent_id,
      avg_duration,
      description,
      price,
    } = req.body;

    if (!talent_id || !price) {
      return res.status(400).json({ error: 'talent_id and price are required' });
    }

    const newPost = await prisma.cam_post.create({
      data: {
        talent_id: Number(talent_id),
        avg_duration: avg_duration ? Number(avg_duration) : null,
        description,
        price: Number(price),
      },
    });

    io?.emit('cam-post-created', newPost);

    res.status(201).json(newPost);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create cam post' });
  }
});

/**
 * Update cam post
 */
router.put('/:cam_post_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { cam_post_id } = req.params;
    const {
      talent_id,
      avg_duration,
      description,
      price,
    } = req.body;

    const existing = await prisma.cam_post.findUnique({
      where: { cam_post_id: Number(cam_post_id) },
    });

    if (!existing) return res.status(404).json({ error: 'Cam post not found' });

    const updatedPost = await prisma.cam_post.update({
      where: { cam_post_id: Number(cam_post_id) },
      data: {
        talent_id: talent_id ? Number(talent_id) : existing.talent_id,
        avg_duration: avg_duration != null ? Number(avg_duration) : existing.avg_duration,
        description: description ?? existing.description,
        price: price != null ? Number(price) : existing.price,
      },
    });

    io?.emit('cam-post-updated', updatedPost);

    res.json(updatedPost);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update cam post' });
  }
});

/**
 * Delete cam post
 */
router.delete('/:cam_post_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const deleted = await prisma.cam_post.delete({
      where: { cam_post_id: Number(req.params.cam_post_id) },
    });

    io?.emit('cam-post-deleted', { cam_post_id: deleted.cam_post_id });

    res.json({ message: 'Cam post deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete cam post' });
  }
});

export default router;