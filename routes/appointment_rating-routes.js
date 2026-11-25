/**
 * DEPRECATED — not mounted in app.js.
 * Medical / booking reviews use the shared booking engine:
 *   POST /booking/bookings/:id/review
 *   GET  /booking/listings/:id/reviews
 * Do not remount this router without an explicit dual-stack migration plan
 * (see docs/medical-maturity-audit.md Phase 1).
 */
// routes/appointmentRating.js
import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/**
 * Get all appointment ratings
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const ratings = await prisma.appointment_rating.findMany({
      orderBy: { rating_id: 'desc' },
      include: {
        user: true,
        appointments: true,
      },
    });

    res.json(ratings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch appointment ratings' });
  }
});

/**
 * Get single appointment rating by rating_id
 */
router.get('/:rating_id', authenticateToken, async (req, res) => {
  try {
    const rating = await prisma.appointment_rating.findUnique({
      where: { rating_id: Number(req.params.rating_id) },
      include: {
        user: true,
        appointments: true,
      },
    });

    if (!rating) return res.status(404).json({ error: 'Appointment rating not found' });

    res.json(rating);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch appointment rating' });
  }
});

/**
 * Create new appointment rating
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const {
      user_id,
      rating,
      review,
      appointment_id,
    } = req.body;

    if (!user_id || !appointment_id || rating == null) {
      return res.status(400).json({ error: 'user_id, appointment_id, and rating are required' });
    }

    const newRating = await prisma.appointment_rating.create({
      data: {
        user_id: Number(user_id),
        rating: Number(rating),
        review,
        appointment_id: Number(appointment_id),
      },
    });

    io?.emit('appointment-rating-created', newRating);

    res.status(201).json(newRating);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create appointment rating' });
  }
});

/**
 * Update appointment rating
 */
router.put('/:rating_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { rating_id } = req.params;
    const { user_id, rating, review, appointment_id } = req.body;

    const existing = await prisma.appointment_rating.findUnique({
      where: { rating_id: Number(rating_id) },
    });

    if (!existing) return res.status(404).json({ error: 'Appointment rating not found' });

    const updatedRating = await prisma.appointment_rating.update({
      where: { rating_id: Number(rating_id) },
      data: {
        user_id: user_id ? Number(user_id) : existing.user_id,
        rating: rating != null ? Number(rating) : existing.rating,
        review: review ?? existing.review,
        appointment_id: appointment_id ? Number(appointment_id) : existing.appointment_id,
      },
    });

    io?.emit('appointment-rating-updated', updatedRating);

    res.json(updatedRating);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update appointment rating' });
  }
});

/**
 * Delete appointment rating
 */
router.delete('/:rating_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const deleted = await prisma.appointment_rating.delete({
      where: { rating_id: Number(req.params.rating_id) },
    });

    io?.emit('appointment-rating-deleted', { rating_id: deleted.rating_id });

    res.json({ message: 'Appointment rating deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete appointment rating' });
  }
});

export default router;