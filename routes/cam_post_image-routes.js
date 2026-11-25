// routes/camPostImage.js
import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/**
 * Get all cam post images
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const images = await prisma.cam_post_image.findMany({
      orderBy: { cam_post_image_id: 'desc' },
      include: {
        cam_post: true,
      },
    });

    res.json(images);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch cam post images' });
  }
});

/**
 * Get single cam post image by cam_post_image_id
 */
router.get('/:cam_post_image_id', authenticateToken, async (req, res) => {
  try {
    const image = await prisma.cam_post_image.findUnique({
      where: { cam_post_image_id: Number(req.params.cam_post_image_id) },
      include: {
        cam_post: true,
      },
    });

    if (!image) return res.status(404).json({ error: 'Cam post image not found' });

    res.json(image);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch cam post image' });
  }
});

/**
 * Create new cam post image
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { cam_post_id, image_url } = req.body;

    if (!cam_post_id || !image_url) {
      return res.status(400).json({ error: 'cam_post_id and image_url are required' });
    }

    const newImage = await prisma.cam_post_image.create({
      data: {
        cam_post_id: Number(cam_post_id),
        image_url,
      },
    });

    io?.emit('cam-post-image-created', newImage);

    res.status(201).json(newImage);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create cam post image' });
  }
});

/**
 * Update cam post image
 */
router.put('/:cam_post_image_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { cam_post_image_id } = req.params;
    const { cam_post_id, image_url } = req.body;

    const existing = await prisma.cam_post_image.findUnique({
      where: { cam_post_image_id: Number(cam_post_image_id) },
    });

    if (!existing) return res.status(404).json({ error: 'Cam post image not found' });

    const updatedImage = await prisma.cam_post_image.update({
      where: { cam_post_image_id: Number(cam_post_image_id) },
      data: {
        cam_post_id: cam_post_id ? Number(cam_post_id) : existing.cam_post_id,
        image_url: image_url ?? existing.image_url,
      },
    });

    io?.emit('cam-post-image-updated', updatedImage);

    res.json(updatedImage);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update cam post image' });
  }
});

/**
 * Delete cam post image
 */
router.delete('/:cam_post_image_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const deleted = await prisma.cam_post_image.delete({
      where: { cam_post_image_id: Number(req.params.cam_post_image_id) },
    });

    io?.emit('cam-post-image-deleted', { cam_post_image_id: deleted.cam_post_image_id });

    res.json({ message: 'Cam post image deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete cam post image' });
  }
});

export default router;