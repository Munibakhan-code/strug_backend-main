import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

//======================================================================================================
//=============================================== CRUD =================================================
//======================================================================================================

// S11: legacy `stream`-table reads. The app has moved to the live_session system and no
// longer calls these, but they previously dumped every stream + chat to anonymous callers.
// Auth-gated as defence-in-depth until the legacy table is retired.

/* GET ALL STREAMS */
router.get('/', authenticateToken, async (_req, res) => {
  try {
    const streams = await prisma.stream.findMany({
      orderBy: { stream_id: 'desc' },
      include: {
        streamer: true,
        stream_chat: true,
      },
    });

    res.json(streams);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch streams' });
  }
});

/* GET STREAM BY ID */
router.get('/:stream_id', authenticateToken, async (req, res) => {
  try {
    const stream_id = Number(req.params.stream_id);

    if (Number.isNaN(stream_id)) {
      return res.status(400).json({ error: 'stream_id must be a number' });
    }

    const stream = await prisma.stream.findUnique({
      where: { stream_id },
      include: {
        streamer: true,
        stream_chat: true,
      },
    });

    if (!stream) {
      return res.status(404).json({ error: 'Stream not found' });
    }

    res.json(stream);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch stream' });
  }
});

/* GET LIVE STREAMS */
router.get('/status/live', authenticateToken, async (_req, res) => {
  try {
    const liveStreams = await prisma.stream.findMany({
      where: { is_ended: false },
      orderBy: { start_time: 'desc' },
      include: {
        streamer: true,
      },
    });

    res.json(liveStreams);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch live streams' });
  }
});

/* GET STREAMS BY STREAMER ID */
router.get('/streamer/:streamer_id', authenticateToken, async (req, res) => {
  try {
    const streamer_id = Number(req.params.streamer_id);

    if (Number.isNaN(streamer_id)) {
      return res.status(400).json({ error: 'streamer_id must be a number' });
    }

    const streams = await prisma.stream.findMany({
      where: { streamer_id },
      orderBy: { start_time: 'desc' },
      include: {
        streamer: true,
      },
    });

    res.json(streams);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch streams for streamer' });
  }
});

/* CREATE STREAM */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const {
      stream_name,
      start_time,
      description,
      stream_url,
      is_ended,
      end_time,
    } = req.body;

    const stream = await prisma.stream.create({
      data: {
        stream_name,
        start_time: start_time ? new Date(start_time) : new Date(),
        description,
        streamer_id: req.user.user_id, // S6: always from JWT, never body
        stream_url,
        is_ended: is_ended ?? false,
        end_time: end_time ? new Date(end_time) : undefined,
      },
      include: {
        streamer: true,
      },
    });

    res.status(201).json(stream);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create stream' });
  }
});

/* UPDATE STREAM */
router.put('/:stream_id', authenticateToken, async (req, res) => {
  try {
    const stream_id = Number(req.params.stream_id);

    if (Number.isNaN(stream_id)) {
      return res.status(400).json({ error: 'stream_id must be a number' });
    }

    const {
      stream_name,
      start_time,
      description,
      stream_url,
      is_ended,
      end_time,
    } = req.body;

    const existing = await prisma.stream.findUnique({ where: { stream_id } });

    if (!existing) {
      return res.status(404).json({ error: 'Stream not found' });
    }

    // S6: only the streamer can update their own stream
    if (existing.streamer_id !== req.user.user_id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const updated = await prisma.stream.update({
      where: { stream_id },
      data: {
        stream_name: stream_name ?? existing.stream_name,
        start_time: start_time ? new Date(start_time) : existing.start_time,
        description: description ?? existing.description,
        streamer_id: existing.streamer_id, // immutable
        stream_url: stream_url ?? existing.stream_url,
        is_ended: is_ended ?? existing.is_ended,
        end_time: end_time ? new Date(end_time) : existing.end_time,
      },
      include: {
        streamer: true,
        stream_chat: true,
      },
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update stream' });
  }
});

/* END STREAM */
router.patch('/:stream_id/end', authenticateToken, async (req, res) => {
  try {
    const stream_id = Number(req.params.stream_id);

    if (Number.isNaN(stream_id)) {
      return res.status(400).json({ error: 'stream_id must be a number' });
    }

    const existing = await prisma.stream.findUnique({ where: { stream_id } });

    if (!existing) {
      return res.status(404).json({ error: 'Stream not found' });
    }

    // S6: only the streamer can end their own stream
    if (existing.streamer_id !== req.user.user_id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const updated = await prisma.stream.update({
      where: { stream_id },
      data: {
        is_ended: true,
        end_time: new Date(),
      },
      include: {
        streamer: true,
      },
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to end stream' });
  }
});

/* DELETE STREAM */
router.delete('/:stream_id', authenticateToken, async (req, res) => {
  try {
    const stream_id = Number(req.params.stream_id);

    if (Number.isNaN(stream_id)) {
      return res.status(400).json({ error: 'stream_id must be a number' });
    }

    const stream = await prisma.stream.findUnique({ where: { stream_id } });
    if (!stream) return res.status(404).json({ error: 'Stream not found' });
    if (stream.streamer_id !== req.user.user_id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await prisma.stream.delete({ where: { stream_id } });
    res.json({ message: 'Stream deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete stream' });
  }
});

//======================================================================================================
//=============================================== END CRUD =============================================//======================================================================================================

export default router;
