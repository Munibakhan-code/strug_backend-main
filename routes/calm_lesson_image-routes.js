// routes/calmLessonImage.js
import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/**
 * Get all calm lesson images
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const images = await prisma.calm_lesson_image.findMany({
      orderBy: { calm_lesson_image_id: 'desc' },
      include: {
        calm_lesson: true,
      },
    });

    res.json(images);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch calm lesson images' });
  }
});

/**
 * Get single calm lesson image
 */
router.get('/:calm_lesson_image_id', authenticateToken, async (req, res) => {
  try {
    const image = await prisma.calm_lesson_image.findUnique({
      where: { calm_lesson_image_id: Number(req.params.calm_lesson_image_id) },
      include: {
        calm_lesson: true,
      },
    });

    if (!image) return res.status(404).json({ error: 'Calm lesson image not found' });

    res.json(image);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch calm lesson image' });
  }
});

/**
 * Create new calm lesson image
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { calm_lesson_id, image_url } = req.body;

    if (!calm_lesson_id || !image_url) {
      return res.status(400).json({ error: 'calm_lesson_id and image_url are required' });
    }

    const newImage = await prisma.calm_lesson_image.create({
      data: {
        calm_lesson_id: Number(calm_lesson_id),
        image_url,
      },
    });

    io?.emit('calm-lesson-image-created', newImage);

    res.status(201).json(newImage);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create calm lesson image' });
  }
});

/**
 * Update calm lesson image
 */
router.put('/:calm_lesson_image_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { calm_lesson_image_id } = req.params;
    const { calm_lesson_id, image_url } = req.body;

    const existing = await prisma.calm_lesson_image.findUnique({
      where: { calm_lesson_image_id: Number(calm_lesson_image_id) },
    });

    if (!existing) return res.status(404).json({ error: 'Calm lesson image not found' });

    const updatedImage = await prisma.calm_lesson_image.update({
      where: { calm_lesson_image_id: Number(calm_lesson_image_id) },
      data: {
        calm_lesson_id: calm_lesson_id ? Number(calm_lesson_id) : existing.calm_lesson_id,
        image_url: image_url ?? existing.image_url,
      },
    });

    io?.emit('calm-lesson-image-updated', updatedImage);

    res.json(updatedImage);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update calm lesson image' });
  }
});

/**
 * Delete calm lesson image
 */
router.delete('/:calm_lesson_image_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const deleted = await prisma.calm_lesson_image.delete({
      where: { calm_lesson_image_id: Number(req.params.calm_lesson_image_id) },
    });

    io?.emit('calm-lesson-image-deleted', { calm_lesson_image_id: deleted.calm_lesson_image_id });

    res.json({ message: 'Calm lesson image deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete calm lesson image' });
  }
});

export default router;