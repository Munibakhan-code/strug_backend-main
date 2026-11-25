import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

// Never expose the full `user` row (it holds the password hash + email). Public-facing
// streamer payloads only ever need these display fields.
const safeUserSelect = { user_id: true, name: true, username: true };

//======================================================================================================
//=============================================== CRUD =================================================
//======================================================================================================

/* GET ALL STREAMERS */
router.get('/', authenticateToken, async (_req, res) => {
  try {
    const streamers = await prisma.streamer.findMany({
      orderBy: { streamer_id: 'desc' },
      include: {
        user: { select: safeUserSelect },
        stream: true,
      },
    });

    res.json(streamers);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch streamers' });
  }
});

/* GET STREAMER BY ID */
router.get('/:streamer_id', authenticateToken, async (req, res) => {
  try {
    const streamer_id = Number(req.params.streamer_id);

    if (Number.isNaN(streamer_id)) {
      return res.status(400).json({ error: 'streamer_id must be a number' });
    }

    const streamer = await prisma.streamer.findUnique({
      where: { streamer_id },
      include: {
        user: { select: safeUserSelect },
        stream: true,
      },
    });

    if (!streamer) {
      return res.status(404).json({ error: 'Streamer not found' });
    }

    res.json(streamer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch streamer' });
  }
});

/* GET STREAMER BY USER ID */
router.get('/user/:user_id', authenticateToken, async (req, res) => {
  try {
    const streamer_user_id = Number(req.params.user_id);

    if (Number.isNaN(streamer_user_id)) {
      return res.status(400).json({ error: 'user_id must be a number' });
    }

    const streamer = await prisma.streamer.findFirst({
      where: { streamer_user_id },
      include: {
        user: { select: safeUserSelect },
        stream: true,
      },
    });

    if (!streamer) {
      return res.status(404).json({ error: 'Streamer not found for this user' });
    }

    res.json(streamer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch streamer' });
  }
});

/* CREATE STREAMER */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { is_save } = req.body;
    // A user may only create their own streamer record; never trust a body user_id.
    const streamer_user_id = req.user.user_id;

    const streamer = await prisma.streamer.create({
      data: {
        streamer_user_id,
        is_save: is_save ?? false,
      },
      include: {
        user: { select: safeUserSelect },
      },
    });

    res.status(201).json(streamer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create streamer' });
  }
});

/* UPDATE STREAMER */
router.put('/:streamer_id', authenticateToken, async (req, res) => {
  try {
    const streamer_id = Number(req.params.streamer_id);

    if (Number.isNaN(streamer_id)) {
      return res.status(400).json({ error: 'streamer_id must be a number' });
    }

    const { is_save } = req.body;

    const existing = await prisma.streamer.findUnique({
      where: { streamer_id },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Streamer not found' });
    }

    // Only the owner may modify their streamer record.
    if (existing.streamer_user_id !== req.user.user_id) {
      return res.status(403).json({ error: 'Not authorized to modify this streamer' });
    }

    const updated = await prisma.streamer.update({
      where: { streamer_id },
      data: {
        is_save: is_save ?? existing.is_save,
      },
      include: {
        user: { select: safeUserSelect },
        stream: true,
      },
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update streamer' });
  }
});

/* DELETE STREAMER */
router.delete('/:streamer_id', authenticateToken, async (req, res) => {
  try {
    const streamer_id = Number(req.params.streamer_id);

    if (Number.isNaN(streamer_id)) {
      return res.status(400).json({ error: 'streamer_id must be a number' });
    }

    const existing = await prisma.streamer.findUnique({ where: { streamer_id } });
    if (!existing) {
      return res.status(404).json({ error: 'Streamer not found' });
    }
    if (existing.streamer_user_id !== req.user.user_id) {
      return res.status(403).json({ error: 'Not authorized to delete this streamer' });
    }

    await prisma.streamer.delete({
      where: { streamer_id },
    });

    res.json({ message: 'Streamer deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete streamer' });
  }
});

//======================================================================================================
//=============================================== END CRUD =============================================
//======================================================================================================

export default router;
