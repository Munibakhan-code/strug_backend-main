// routes/bookingType.js
import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/**
 * Get all booking types
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const types = await prisma.booking_type.findMany({
      orderBy: { booking_type_id: 'asc' },
    });
    res.json(types);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch booking types' });
  }
});

/**
 * Get single booking type
 */
router.get('/:booking_type_id', authenticateToken, async (req, res) => {
  try {
    const type = await prisma.booking_type.findUnique({
      where: { booking_type_id: Number(req.params.booking_type_id) },
    });
    if (!type) return res.status(404).json({ error: 'Booking type not found' });
    res.json(type);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch booking type' });
  }
});

/**
 * Create booking type
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const { booking_type } = req.body;
    if (!booking_type) {
      return res.status(400).json({ error: 'booking_type is required' });
    }
    const newType = await prisma.booking_type.create({
      data: { booking_type },
    });
    io?.emit('booking-type-created', newType);
    res.status(201).json(newType);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create booking type' });
  }
});

/**
 * Update booking type
 */
router.put('/:booking_type_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const { booking_type_id } = req.params;
    const { booking_type } = req.body;
    const existing = await prisma.booking_type.findUnique({
      where: { booking_type_id: Number(booking_type_id) },
    });
    if (!existing) return res.status(404).json({ error: 'Booking type not found' });
    const updated = await prisma.booking_type.update({
      where: { booking_type_id: Number(booking_type_id) },
      data: { booking_type: booking_type ?? existing.booking_type },
    });
    io?.emit('booking-type-updated', updated);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update booking type' });
  }
});

/**
 * Delete booking type
 */
router.delete('/:booking_type_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const deleted = await prisma.booking_type.delete({
      where: { booking_type_id: Number(req.params.booking_type_id) },
    });
    io?.emit('booking-type-deleted', { booking_type_id: deleted.booking_type_id });
    res.json({ message: 'Booking type deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete booking type' });
  }
});

export default router;