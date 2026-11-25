import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/**
 * Get all event types
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const eventTypes = await prisma.event_type.findMany({
      orderBy: { event_type_id: 'asc' },
      include: {
        place: true,
        place_orders: true,
        place_pics: true,
      },
    });
    res.json(eventTypes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch event types' });
  }
});

/**
 * Get single event type
 */
router.get('/:event_type_id', authenticateToken, async (req, res) => {
  try {
    const eventType = await prisma.event_type.findUnique({
      where: { event_type_id: Number(req.params.event_type_id) },
      include: {
        place: true,
        place_orders: true,
        place_pics: true,
      },
    });

    if (!eventType) return res.status(404).json({ error: 'Event type not found' });

    res.json(eventType);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch event type' });
  }
});

/**
 * Create event type
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { event_type_name } = req.body;

    if (!event_type_name) {
      return res.status(400).json({ error: 'event_type_name is required' });
    }

    const newEventType = await prisma.event_type.create({
      data: { event_type_name },
    });

    io?.emit('event-type-created', newEventType);

    res.status(201).json(newEventType);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create event type' });
  }
});

/**
 * Update event type
 */
router.put('/:event_type_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { event_type_id } = req.params;
    const { event_type_name } = req.body;

    const existing = await prisma.event_type.findUnique({
      where: { event_type_id: Number(event_type_id) },
    });

    if (!existing) return res.status(404).json({ error: 'Event type not found' });

    const updatedEventType = await prisma.event_type.update({
      where: { event_type_id: Number(event_type_id) },
      data: { event_type_name },
    });

    io?.emit('event-type-updated', updatedEventType);

    res.json(updatedEventType);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update event type' });
  }
});

/**
 * Delete event type
 */
router.delete('/:event_type_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const deleted = await prisma.event_type.delete({
      where: { event_type_id: Number(req.params.event_type_id) },
    });

    io?.emit('event-type-deleted', { event_type_id: deleted.event_type_id });

    res.json({ message: 'Event type deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete event type' });
  }
});

export default router;
