import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/**
 * Get all connections
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const connections = await prisma.connections.findMany({
      orderBy: { connection_id: 'desc' },
      include: {
        platform_type: true,
        user_connections_requester_idTouser: true,
        user_connections_receiver_idTouser: true,
      },
    });

    res.json(connections);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch connections' });
  }
});

/**
 * Get single connection
 */
router.get('/:connection_id', authenticateToken, async (req, res) => {
  try {
    const connection = await prisma.connections.findUnique({
      where: { connection_id: Number(req.params.connection_id) },
      include: {
        platform_type: true,
        user_connections_requester_idTouser: true,
        user_connections_receiver_idTouser: true,
      },
    });

    if (!connection)
      return res.status(404).json({ error: 'Connection not found' });

    res.json(connection);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch connection' });
  }
});

/**
 * Send connection request
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const {
      requester_id,
      receiver_id,
      platform_type_id,
    } = req.body;

    if (!requester_id || !receiver_id) {
      return res.status(400).json({
        error: 'requester_id and receiver_id are required',
      });
    }

    // prevent self connection
    if (requester_id === receiver_id) {
      return res.status(400).json({
        error: 'Cannot connect with yourself',
      });
    }

    const connection = await prisma.connections.create({
      data: {
        requester_id,
        receiver_id,
        status: 'pending',
        platform_type_id,
      },
    });

    io?.emit('connection-request-sent', connection);

    res.status(201).json(connection);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send connection request' });
  }
});

/**
 * Accept connection request
 */
router.put('/:connection_id/accept', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const connection_id = Number(req.params.connection_id);

    const existing = await prisma.connections.findUnique({
      where: { connection_id },
    });

    if (!existing)
      return res.status(404).json({ error: 'Connection not found' });

    const updated = await prisma.connections.update({
      where: { connection_id },
      data: {
        status: 'accepted',
        accepted_time: new Date(),
      },
    });

    io?.emit('connection-accepted', updated);

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to accept connection' });
  }
});

/**
 * Reject / cancel connection
 */
router.put('/:connection_id/reject', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const connection_id = Number(req.params.connection_id);

    const existing = await prisma.connections.findUnique({
      where: { connection_id },
    });

    if (!existing)
      return res.status(404).json({ error: 'Connection not found' });

    const updated = await prisma.connections.update({
      where: { connection_id },
      data: {
        status: 'rejected',
      },
    });

    io?.emit('connection-rejected', updated);

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to reject connection' });
  }
});

/**
 * Delete connection (unfriend)
 */
router.delete('/:connection_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const deleted = await prisma.connections.delete({
      where: { connection_id: Number(req.params.connection_id) },
    });

    io?.emit('connection-removed', {
      connection_id: deleted.connection_id,
    });

    res.json({ message: 'Connection removed successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove connection' });
  }
});

export default router;