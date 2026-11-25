// routes/calmLesson.js
import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/**
 * Get all calm lessons
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const lessons = await prisma.calm_lesson.findMany({
      orderBy: { calm_lesson_id: 'desc' },
      include: {
        calm_providers: true,
      },
    });

    res.json(lessons);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch calm lessons' });
  }
});

/**
 * Get single calm lesson
 */
router.get('/:calm_lesson_id', authenticateToken, async (req, res) => {
  try {
    const lesson = await prisma.calm_lesson.findUnique({
      where: { calm_lesson_id: Number(req.params.calm_lesson_id) },
      include: {
        calm_providers: true,
      },
    });

    if (!lesson) return res.status(404).json({ error: 'Calm lesson not found' });

    res.json(lesson);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch calm lesson' });
  }
});

/**
 * Create new calm lesson
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const {
      calm_provider_id,
      lesson_name,
      lesson_description,
      lesson_duration,
      lesson_price,
      lesson_trailer_video_url,
    } = req.body;

    if (!calm_provider_id || !lesson_name || !lesson_price) {
      return res.status(400).json({ error: 'calm_provider_id, lesson_name, and lesson_price are required' });
    }

    const newLesson = await prisma.calm_lesson.create({
      data: {
        calm_provider_id: Number(calm_provider_id),
        lesson_name,
        lesson_description,
        lesson_duration: lesson_duration ? Number(lesson_duration) : null,
        lesson_price: Number(lesson_price),
        lesson_trailer_video_url,
      },
    });

    io?.emit('calm-lesson-created', newLesson);

    res.status(201).json(newLesson);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create calm lesson' });
  }
});

/**
 * Update calm lesson
 */
router.put('/:calm_lesson_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { calm_lesson_id } = req.params;
    const {
      calm_provider_id,
      lesson_name,
      lesson_description,
      lesson_duration,
      lesson_price,
      lesson_trailer_video_url,
    } = req.body;

    const existing = await prisma.calm_lesson.findUnique({
      where: { calm_lesson_id: Number(calm_lesson_id) },
    });

    if (!existing) return res.status(404).json({ error: 'Calm lesson not found' });

    const updatedLesson = await prisma.calm_lesson.update({
      where: { calm_lesson_id: Number(calm_lesson_id) },
      data: {
        calm_provider_id: calm_provider_id ? Number(calm_provider_id) : existing.calm_provider_id,
        lesson_name: lesson_name ?? existing.lesson_name,
        lesson_description: lesson_description ?? existing.lesson_description,
        lesson_duration: lesson_duration != null ? Number(lesson_duration) : existing.lesson_duration,
        lesson_price: lesson_price != null ? Number(lesson_price) : existing.lesson_price,
        lesson_trailer_video_url: lesson_trailer_video_url ?? existing.lesson_trailer_video_url,
      },
    });

    io?.emit('calm-lesson-updated', updatedLesson);

    res.json(updatedLesson);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update calm lesson' });
  }
});

/**
 * Delete calm lesson
 */
router.delete('/:calm_lesson_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const deleted = await prisma.calm_lesson.delete({
      where: { calm_lesson_id: Number(req.params.calm_lesson_id) },
    });

    io?.emit('calm-lesson-deleted', { calm_lesson_id: deleted.calm_lesson_id });

    res.json({ message: 'Calm lesson deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete calm lesson' });
  }
});

export default router;