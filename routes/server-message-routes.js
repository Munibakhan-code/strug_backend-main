import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

//======================================================================================================
//=============================================== CRUD =================================================
//======================================================================================================

/* GET ALL SERVER MESSAGES */
router.get('/', /*authenticateToken,*/ async (_req, res) => {
  try {
    const serverMessages = await prisma.server_message.findMany({
      orderBy: { server_message_id: 'desc' },
      include: {
        user: true,
        discord_server: true,
      },
    });

    res.json(serverMessages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch server messages' });
  }
});

/* GET SERVER MESSAGE BY ID */
router.get('/:server_message_id', /*authenticateToken,*/ async (req, res) => {
  try {
    const server_message_id = Number(req.params.server_message_id);

    if (Number.isNaN(server_message_id)) {
      return res.status(400).json({ error: 'server_message_id must be a number' });
    }

    const serverMessage = await prisma.server_message.findUnique({
      where: { server_message_id },
      include: {
        user: true,
        discord_server: true,
      },
    });

    if (!serverMessage) {
      return res.status(404).json({ error: 'Server message not found' });
    }

    res.json(serverMessage);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch server message' });
  }
});

/* GET MESSAGES BY SERVER ID */
router.get('/server/:server_id', /*authenticateToken,*/ async (req, res) => {
  try {
    const server_id = Number(req.params.server_id);

    if (Number.isNaN(server_id)) {
      return res.status(400).json({ error: 'server_id must be a number' });
    }

    const messages = await prisma.server_message.findMany({
      where: { server_id },
      orderBy: { sent_time: 'asc' },
      include: {
        user: true,
      },
    });

    res.json(messages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch messages for server' });
  }
});

/* CREATE SERVER MESSAGE */
router.post('/', /*authenticateToken,*/ async (req, res) => {
  try {
    const { server_id, message, sender_user_id, sent_time } = req.body;

    const serverMessage = await prisma.server_message.create({
      data: {
        server_id,
        message,
        sender_user_id,
        sent_time: sent_time ? new Date(sent_time) : new Date(),
      },
      include: {
        user: true,
        discord_server: true,
      },
    });

    res.status(201).json(serverMessage);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create server message' });
  }
});

/* UPDATE SERVER MESSAGE */
router.put('/:server_message_id', /*authenticateToken,*/ async (req, res) => {
  try {
    const server_message_id = Number(req.params.server_message_id);

    if (Number.isNaN(server_message_id)) {
      return res.status(400).json({ error: 'server_message_id must be a number' });
    }

    const { server_id, message, sender_user_id, sent_time } = req.body;

    const existing = await prisma.server_message.findUnique({
      where: { server_message_id },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Server message not found' });
    }

    const updated = await prisma.server_message.update({
      where: { server_message_id },
      data: {
        server_id: server_id ?? existing.server_id,
        message: message ?? existing.message,
        sender_user_id: sender_user_id ?? existing.sender_user_id,
        sent_time: sent_time ? new Date(sent_time) : existing.sent_time,
      },
      include: {
        user: true,
        discord_server: true,
      },
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update server message' });
  }
});

/* DELETE SERVER MESSAGE */
router.delete('/:server_message_id', /*authenticateToken,*/ async (req, res) => {
  try {
    const server_message_id = Number(req.params.server_message_id);

    if (Number.isNaN(server_message_id)) {
      return res.status(400).json({ error: 'server_message_id must be a number' });
    }

    await prisma.server_message.delete({
      where: { server_message_id },
    });

    res.json({ message: 'Server message deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete server message' });
  }
});

//======================================================================================================
//=============================================== END CRUD =============================================
//======================================================================================================

export default router;
