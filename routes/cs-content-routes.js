import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/**
 * Get all CS content
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const contentList = await prisma.cs_content.findMany({
      orderBy: { content_id: 'desc' },
      include: {
        cs_categories: true,
        cs_type: true,
      },
    });

    res.json(contentList);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch CS content' });
  }
});

/**
 * Get single CS content
 */
router.get('/:content_id', authenticateToken, async (req, res) => {
  try {
    const content = await prisma.cs_content.findUnique({
      where: { content_id: Number(req.params.content_id) },
      include: {
        cs_categories: true,
        cs_type: true,
      },
    });

    if (!content)
      return res.status(404).json({ error: 'CS content not found' });

    res.json(content);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch CS content' });
  }
});

/**
 * Create CS content
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const {
      content_title,
      content_description,
      content_url,
      author,
      date,
      cover_img_url,
      length,
      cs_category_id,
      cs_type_id,
    } = req.body;

    if (!content_title) {
      return res.status(400).json({ error: 'content_title is required' });
    }

    const newContent = await prisma.cs_content.create({
      data: {
        content_title,
        content_description,
        content_url,
        author,
        date: date ? new Date(date) : new Date(),
        cover_img_url,
        length,
        cs_category_id,
        cs_type_id,
      },
    });

    io?.emit('cs-content-created', newContent);

    res.status(201).json(newContent);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create CS content' });
  }
});

/**
 * Update CS content
 */
router.put('/:content_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { content_id } = req.params;
    const {
      content_title,
      content_description,
      content_url,
      author,
      date,
      cover_img_url,
      length,
      cs_category_id,
      cs_type_id,
    } = req.body;

    const existing = await prisma.cs_content.findUnique({
      where: { content_id: Number(content_id) },
    });

    if (!existing)
      return res.status(404).json({ error: 'CS content not found' });

    const updatedContent = await prisma.cs_content.update({
      where: { content_id: Number(content_id) },
      data: {
        content_title,
        content_description,
        content_url,
        author,
        date: date ? new Date(date) : existing.date,
        cover_img_url,
        length,
        cs_category_id,
        cs_type_id,
      },
    });

    io?.emit('cs-content-updated', updatedContent);

    res.json(updatedContent);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update CS content' });
  }
});

/**
 * Delete CS content
 */
router.delete('/:content_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const deleted = await prisma.cs_content.delete({
      where: { content_id: Number(req.params.content_id) },
    });

    io?.emit('cs-content-deleted', { content_id: deleted.content_id });

    res.json({ message: 'CS content deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete CS content' });
  }
});

export default router;
