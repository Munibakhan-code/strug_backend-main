import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/**
 * Get all Discord servers
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const servers = await prisma.discord_server.findMany({
      orderBy: { server_id: 'asc' },
      include: {
        user: true,
        server_members: true,
        server_message: true,
      },
    });

    res.json(servers);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch Discord servers' });
  }
});

/**
 * Get single Discord server
 */
router.get('/:server_id', authenticateToken, async (req, res) => {
  try {
    const server = await prisma.discord_server.findUnique({
      where: { server_id: Number(req.params.server_id) },
      include: {
        user: true,
        server_members: true,
        server_message: true,
      },
    });

    if (!server) return res.status(404).json({ error: 'Discord server not found' });

    res.json(server);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch Discord server' });
  }
});

/**
 * Create Discord server
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { server_name, server_owner } = req.body;

    if (!server_name || !server_owner) {
      return res.status(400).json({ error: 'server_name and server_owner are required' });
    }

    const newServer = await prisma.discord_server.create({
      data: {
        server_name,
        server_owner,
        created_at: new Date(),
      },
    });

    io?.emit('discord-server-created', newServer);

    res.status(201).json(newServer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create Discord server' });
  }
});

/**
 * Update Discord server
 */
router.put('/:server_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { server_id } = req.params;
    const { server_name, server_owner } = req.body;

    const existing = await prisma.discord_server.findUnique({
      where: { server_id: Number(server_id) },
    });

    if (!existing) return res.status(404).json({ error: 'Discord server not found' });

    const updatedServer = await prisma.discord_server.update({
      where: { server_id: Number(server_id) },
      data: {
        server_name,
        server_owner,
      },
    });

    io?.emit('discord-server-updated', updatedServer);

    res.json(updatedServer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update Discord server' });
  }
});

/**
 * Delete Discord server
 */
router.delete('/:server_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const deleted = await prisma.discord_server.delete({
      where: { server_id: Number(req.params.server_id) },
    });

    io?.emit('discord-server-deleted', { server_id: deleted.server_id });

    res.json({ message: 'Discord server deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete Discord server' });
  }
});

export default router;
