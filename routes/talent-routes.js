import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

//======================================================================================================
//=============================================== CRUD =================================================
//======================================================================================================

/* GET ALL TALENTS */
router.get('/', /*authenticateToken,*/ async (_req, res) => {
  try {
    const talents = await prisma.talent.findMany({
      orderBy: { talent_id: 'desc' },
      include: {
        user: true,
        talent_category: true,
        cam_post: true,
      },
    });

    res.json(talents);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch talents' });
  }
});

/* GET TALENT BY ID */
router.get('/:talent_id', /*authenticateToken,*/ async (req, res) => {
  try {
    const talent_id = Number(req.params.talent_id);

    if (Number.isNaN(talent_id)) {
      return res.status(400).json({ error: 'talent_id must be a number' });
    }

    const talent = await prisma.talent.findUnique({
      where: { talent_id },
      include: {
        user: true,
        talent_category: true,
        cam_post: true,
      },
    });

    if (!talent) {
      return res.status(404).json({ error: 'Talent not found' });
    }

    res.json(talent);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch talent' });
  }
});

/* GET TALENT BY USER ID */
router.get('/user/:user_id', /*authenticateToken,*/ async (req, res) => {
  try {
    const talent_user_id = Number(req.params.user_id);

    if (Number.isNaN(talent_user_id)) {
      return res.status(400).json({ error: 'user_id must be a number' });
    }

    const talent = await prisma.talent.findFirst({
      where: { talent_user_id },
      include: {
        user: true,
        talent_category: true,
        cam_post: true,
      },
    });

    if (!talent) {
      return res.status(404).json({ error: 'Talent not found for this user' });
    }

    res.json(talent);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch talent' });
  }
});

/* GET TALENTS BY CATEGORY ID */
router.get('/category/:category_id', /*authenticateToken,*/ async (req, res) => {
  try {
    const talent_category_id = Number(req.params.category_id);

    if (Number.isNaN(talent_category_id)) {
      return res.status(400).json({ error: 'category_id must be a number' });
    }

    const talents = await prisma.talent.findMany({
      where: { talent_category_id },
      include: {
        user: true,
        talent_category: true,
      },
    });

    res.json(talents);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch talents for category' });
  }
});

/* CREATE TALENT */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const {
      talent_user_id,
      talent_description,
      profile_image_url,
      talent_category_id,
    } = req.body;

    const talent = await prisma.talent.create({
      data: {
        talent_user_id,
        talent_description,
        profile_image_url,
        talent_category_id,
      },
      include: {
        user: true,
        talent_category: true,
      },
    });

    res.status(201).json(talent);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create talent' });
  }
});

/* UPDATE TALENT */
router.put('/:talent_id', authenticateToken, async (req, res) => {
  try {
    const talent_id = Number(req.params.talent_id);

    if (Number.isNaN(talent_id)) {
      return res.status(400).json({ error: 'talent_id must be a number' });
    }

    const {
      talent_user_id,
      talent_description,
      profile_image_url,
      talent_category_id,
    } = req.body;

    const existing = await prisma.talent.findUnique({
      where: { talent_id },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Talent not found' });
    }

    const isAdmin = req.user.role === 'ADMIN';
    if (existing.talent_user_id !== req.user.user_id && !isAdmin) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const updated = await prisma.talent.update({
      where: { talent_id },
      data: {
        // Non-admins cannot reassign ownership to another user.
        talent_user_id: isAdmin ? (talent_user_id ?? existing.talent_user_id) : existing.talent_user_id,
        talent_description: talent_description ?? existing.talent_description,
        profile_image_url: profile_image_url ?? existing.profile_image_url,
        talent_category_id: talent_category_id ?? existing.talent_category_id,
      },
      include: {
        user: true,
        talent_category: true,
        cam_post: true,
      },
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update talent' });
  }
});

/* DELETE TALENT */
router.delete('/:talent_id', authenticateToken, async (req, res) => {
  try {
    const talent_id = Number(req.params.talent_id);

    if (Number.isNaN(talent_id)) {
      return res.status(400).json({ error: 'talent_id must be a number' });
    }

    const existing = await prisma.talent.findUnique({ where: { talent_id } });
    if (!existing) {
      return res.status(404).json({ error: 'Talent not found' });
    }
    if (existing.talent_user_id !== req.user.user_id && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await prisma.talent.delete({
      where: { talent_id },
    });

    res.json({ message: 'Talent deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete talent' });
  }
});

//======================================================================================================
//=============================================== END CRUD =============================================
//======================================================================================================

export default router;
