import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken, requireAdmin } from '../middleware/authentication.js';

const router = express.Router();

//======================================================================================================
//=============================================== CRUD =================================================
//======================================================================================================

/* GET ALL STREAM CATEGORIES */
router.get('/', /*authenticateToken,*/ async (_req, res) => {
  try {
    const streamCategories = await prisma.stream_category.findMany({
      orderBy: { stream_category_id: 'desc' },
    });

    res.json(streamCategories);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch stream categories' });
  }
});

/* GET STREAM CATEGORY BY ID */
router.get('/:stream_category_id', /*authenticateToken,*/ async (req, res) => {
  try {
    const stream_category_id = Number(req.params.stream_category_id);

    if (Number.isNaN(stream_category_id)) {
      return res.status(400).json({ error: 'stream_category_id must be a number' });
    }

    const streamCategory = await prisma.stream_category.findUnique({
      where: { stream_category_id },
    });

    if (!streamCategory) {
      return res.status(404).json({ error: 'Stream category not found' });
    }

    res.json(streamCategory);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch stream category' });
  }
});

/* CREATE STREAM CATEGORY */
router.post('/', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { stream_category_name } = req.body;

    const streamCategory = await prisma.stream_category.create({
      data: {
        stream_category_name,
      },
    });

    res.status(201).json(streamCategory);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create stream category' });
  }
});

/* UPDATE STREAM CATEGORY */
router.put('/:stream_category_id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const stream_category_id = Number(req.params.stream_category_id);

    if (Number.isNaN(stream_category_id)) {
      return res.status(400).json({ error: 'stream_category_id must be a number' });
    }

    const { stream_category_name } = req.body;

    const existing = await prisma.stream_category.findUnique({
      where: { stream_category_id },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Stream category not found' });
    }

    const updated = await prisma.stream_category.update({
      where: { stream_category_id },
      data: {
        stream_category_name: stream_category_name ?? existing.stream_category_name,
      },
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update stream category' });
  }
});

/* DELETE STREAM CATEGORY */
router.delete('/:stream_category_id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const stream_category_id = Number(req.params.stream_category_id);

    if (Number.isNaN(stream_category_id)) {
      return res.status(400).json({ error: 'stream_category_id must be a number' });
    }

    await prisma.stream_category.delete({
      where: { stream_category_id },
    });

    res.json({ message: 'Stream category deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete stream category' });
  }
});

//======================================================================================================
//=============================================== END CRUD =============================================
//======================================================================================================

export default router;
