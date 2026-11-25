import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/**
 * Get all Discord streams
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const streams = await prisma.discord_stream.findMany({
      orderBy: { stream_id: 'desc' },
      include: { server_members: true },
    });

    res.json(streams);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch Discord streams' });
  }
});

/**
 * Get single Discord stream
 */
router.get('/:stream_id', authenticateToken, async (req, res) => {
  try {
    const stream = await prisma.discord_stream.findUnique({
      where: { stream_id: Number(req.params.stream_id) },
      include: { server_members: true },
    });

    if (!stream) return res.status(404).json({ error: 'Discord stream not found' });

    res.json(stream);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch Discord stream' });
  }
});

/**
 * Create Discord stream
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { server_member_id, is_audio, is_video, start_time } = req.body;

    if (!server_member_id) {
      return res.status(400).json({ error: 'server_member_id is required' });
    }

    const newStream = await prisma.discord_stream.create({
      data: {
        server_member_id,
        is_audio: is_audio ?? false,
        is_video: is_video ?? false,
        start_time: start_time ? new Date(start_time) : new Date(),
      },
    });

    io?.emit('discord-stream-created', newStream);

    res.status(201).json(newStream);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create Discord stream' });
  }
});

/**
 * Update Discord stream
 */
router.put('/:stream_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { stream_id } = req.params;
    const { server_member_id, is_audio, is_video, start_time } = req.body;

    const existing = await prisma.discord_stream.findUnique({
      where: { stream_id: Number(stream_id) },
    });

    if (!existing) return res.status(404).json({ error: 'Discord stream not found' });

    const updatedStream = await prisma.discord_stream.update({
      where: { stream_id: Number(stream_id) },
      data: {
        server_member_id,
        is_audio,
        is_video,
        start_time: start_time ? new Date(start_time) : existing.start_time,
      },
    });

    io?.emit('discord-stream-updated', updatedStream);

    res.json(updatedStream);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update Discord stream' });
  }
});

/**
 * Delete Discord stream
 */
router.delete('/:stream_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const deleted = await prisma.discord_stream.delete({
      where: { stream_id: Number(req.params.stream_id) },
    });

    io?.emit('discord-stream-deleted', { stream_id: deleted.stream_id });

    res.json({ message: 'Discord stream deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete Discord stream' });
  }
});

export default router;
