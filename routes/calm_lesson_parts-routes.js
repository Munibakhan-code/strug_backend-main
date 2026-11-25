// routes/calmLessonParts.js
import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/**
 * Get all calm lesson parts
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const parts = await prisma.calm_lesson_parts.findMany({
      orderBy: { calm_lesson_parts_id: 'asc' },
      include: {
        calm_lesson: true,
      },
    });

    res.json(parts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch calm lesson parts' });
  }
});

/**
 * Get single calm lesson part
 */
router.get('/:calm_lesson_parts_id', authenticateToken, async (req, res) => {
  try {
    const part = await prisma.calm_lesson_parts.findUnique({
      where: { calm_lesson_parts_id: Number(req.params.calm_lesson_parts_id) },
      include: {
        calm_lesson: true,
      },
    });

    if (!part) return res.status(404).json({ error: 'Calm lesson part not found' });

    res.json(part);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch calm lesson part' });
  }
});

/**
 * Create new calm lesson part
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const {
      calm_lesson_id,
      lesson_part_order,
      content_url,
      part_name,
      part_description,
      part_duration,
    } = req.body;

    if (!calm_lesson_id || !lesson_part_order || !content_url || !part_name) {
      return res.status(400).json({ error: 'calm_lesson_id, lesson_part_order, content_url and part_name are required' });
    }

    const newPart = await prisma.calm_lesson_parts.create({
      data: {
        calm_lesson_id: Number(calm_lesson_id),
        lesson_part_order: Number(lesson_part_order),
        content_url,
        part_name,
        part_description,
        part_duration: part_duration ? Number(part_duration) : null,
      },
    });

    io?.emit('calm-lesson-part-created', newPart);

    res.status(201).json(newPart);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create calm lesson part' });
  }
});

/**
 * Update calm lesson part
 */
router.put('/:calm_lesson_parts_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { calm_lesson_parts_id } = req.params;
    const {
      calm_lesson_id,
      lesson_part_order,
      content_url,
      part_name,
      part_description,
      part_duration,
    } = req.body;

    const existing = await prisma.calm_lesson_parts.findUnique({
      where: { calm_lesson_parts_id: Number(calm_lesson_parts_id) },
    });

    if (!existing) return res.status(404).json({ error: 'Calm lesson part not found' });

    const updatedPart = await prisma.calm_lesson_parts.update({
      where: { calm_lesson_parts_id: Number(calm_lesson_parts_id) },
      data: {
        calm_lesson_id: calm_lesson_id ? Number(calm_lesson_id) : existing.calm_lesson_id,
        lesson_part_order: lesson_part_order ? Number(lesson_part_order) : existing.lesson_part_order,
        content_url: content_url ?? existing.content_url,
        part_name: part_name ?? existing.part_name,
        part_description: part_description ?? existing.part_description,
        part_duration: part_duration != null ? Number(part_duration) : existing.part_duration,
      },
    });

    io?.emit('calm-lesson-part-updated', updatedPart);

    res.json(updatedPart);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update calm lesson part' });
  }
});

/**
 * Delete calm lesson part
 */
router.delete('/:calm_lesson_parts_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const deleted = await prisma.calm_lesson_parts.delete({
      where: { calm_lesson_parts_id: Number(req.params.calm_lesson_parts_id) },
    });

    io?.emit('calm-lesson-part-deleted', { calm_lesson_parts_id: deleted.calm_lesson_parts_id });

    res.json({ message: 'Calm lesson part deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete calm lesson part' });
  }
});

export default router;