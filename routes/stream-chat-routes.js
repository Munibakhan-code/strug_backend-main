import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken, requireAdmin } from '../middleware/authentication.js';

const router = express.Router();

// Only expose a small, non-sensitive slice of the user on a chat row. The global Prisma
// `omit` extension already strips password/email, but a chat never needs the full user.
const CHAT_USER_SELECT = { select: { user_id: true, name: true, username: true } };

//======================================================================================================
//=============================================== CRUD =================================================
//======================================================================================================

/* GET ALL STREAM CHATS (admin only — full-table dump) */
router.get('/', authenticateToken, requireAdmin, async (_req, res) => {
  try {
    const streamChats = await prisma.stream_chat.findMany({
      orderBy: { stream_chat_id: 'desc' },
      take: 200,
      include: {
        stream: true,
        user: CHAT_USER_SELECT,
      },
    });

    res.json(streamChats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch stream chats' });
  }
});

/* GET STREAM CHAT BY ID */
router.get('/:stream_chat_id', authenticateToken, async (req, res) => {
  try {
    const stream_chat_id = Number(req.params.stream_chat_id);

    if (Number.isNaN(stream_chat_id)) {
      return res.status(400).json({ error: 'stream_chat_id must be a number' });
    }

    const streamChat = await prisma.stream_chat.findUnique({
      where: { stream_chat_id },
      include: {
        stream: true,
        user: CHAT_USER_SELECT,
      },
    });

    if (!streamChat) {
      return res.status(404).json({ error: 'Stream chat not found' });
    }

    res.json(streamChat);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch stream chat' });
  }
});

/* GET CHATS BY STREAM ID */
router.get('/stream/:stream_id', authenticateToken, async (req, res) => {
  try {
    const stream_id = Number(req.params.stream_id);

    if (Number.isNaN(stream_id)) {
      return res.status(400).json({ error: 'stream_id must be a number' });
    }

    const chats = await prisma.stream_chat.findMany({
      where: { stream_id },
      orderBy: { sent_time: 'asc' },
      take: 500,
      include: {
        user: CHAT_USER_SELECT,
      },
    });

    res.json(chats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch chats for stream' });
  }
});

/* CREATE STREAM CHAT */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { stream_id, message, sent_time } = req.body;

    const streamChat = await prisma.stream_chat.create({
      data: {
        stream_id,
        message: typeof message === 'string' ? message.slice(0, 500) : message,
        sent_time: sent_time ? new Date(sent_time) : new Date(),
        // Authorship is taken from the authenticated JWT, never the request body.
        user_id: req.user.user_id,
      },
      include: {
        stream: true,
        user: CHAT_USER_SELECT,
      },
    });

    res.status(201).json(streamChat);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create stream chat' });
  }
});

/* UPDATE STREAM CHAT (author only) */
router.put('/:stream_chat_id', authenticateToken, async (req, res) => {
  try {
    const stream_chat_id = Number(req.params.stream_chat_id);

    if (Number.isNaN(stream_chat_id)) {
      return res.status(400).json({ error: 'stream_chat_id must be a number' });
    }

    const { message, sent_time } = req.body;

    const existing = await prisma.stream_chat.findUnique({
      where: { stream_chat_id },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Stream chat not found' });
    }

    // Only the original author may edit their message.
    if (existing.user_id !== req.user.user_id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const updated = await prisma.stream_chat.update({
      where: { stream_chat_id },
      data: {
        // stream_id and user_id are immutable; only the message text/time can change.
        message: message != null ? String(message).slice(0, 500) : existing.message,
        sent_time: sent_time ? new Date(sent_time) : existing.sent_time,
      },
      include: {
        stream: true,
        user: CHAT_USER_SELECT,
      },
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update stream chat' });
  }
});

/* DELETE STREAM CHAT (author or admin) */
router.delete('/:stream_chat_id', authenticateToken, async (req, res) => {
  try {
    const stream_chat_id = Number(req.params.stream_chat_id);

    if (Number.isNaN(stream_chat_id)) {
      return res.status(400).json({ error: 'stream_chat_id must be a number' });
    }

    const existing = await prisma.stream_chat.findUnique({
      where: { stream_chat_id },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Stream chat not found' });
    }

    // The author may delete their own message; admins may delete any (moderation).
    if (existing.user_id !== req.user.user_id && req.user.permission !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await prisma.stream_chat.delete({
      where: { stream_chat_id },
    });

    res.json({ message: 'Stream chat deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete stream chat' });
  }
});

//======================================================================================================
//=============================================== END CRUD =============================================
//======================================================================================================

export default router;
