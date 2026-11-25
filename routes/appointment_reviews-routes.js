/**
 * DEPRECATED — not mounted in app.js.
 * Prefer booking-engine reviews (POST /booking/bookings/:id/review).
 * See docs/medical-maturity-audit.md Phase 1.
 */
// routes/appointmentReviews.js
import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/**
 * Get all appointment reviews
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const reviews = await prisma.appointment_reviews.findMany({
      orderBy: { review_id: 'desc' },
      include: {
        user: true,
        appointments: true,
      },
    });

    res.json(reviews);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch appointment reviews' });
  }
});

/**
 * Get single appointment review by review_id
 */
router.get('/:review_id', authenticateToken, async (req, res) => {
  try {
    const review = await prisma.appointment_reviews.findUnique({
      where: { review_id: Number(req.params.review_id) },
      include: {
        user: true,
        appointments: true,
      },
    });

    if (!review) return res.status(404).json({ error: 'Appointment review not found' });

    res.json(review);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch appointment review' });
  }
});

/**
 * Create new appointment review
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const {
      user_id,
      review,
      appointment_id,
    } = req.body;

    if (!user_id || !appointment_id || !review) {
      return res.status(400).json({ error: 'user_id, appointment_id, and review are required' });
    }

    const newReview = await prisma.appointment_reviews.create({
      data: {
        user_id: Number(user_id),
        review,
        appointment_id: Number(appointment_id),
      },
    });

    io?.emit('appointment-review-created', newReview);

    res.status(201).json(newReview);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create appointment review' });
  }
});

/**
 * Update appointment review
 */
router.put('/:review_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { review_id } = req.params;
    const { user_id, review, appointment_id } = req.body;

    const existing = await prisma.appointment_reviews.findUnique({
      where: { review_id: Number(review_id) },
    });

    if (!existing) return res.status(404).json({ error: 'Appointment review not found' });

    const updatedReview = await prisma.appointment_reviews.update({
      where: { review_id: Number(review_id) },
      data: {
        user_id: user_id ? Number(user_id) : existing.user_id,
        review: review ?? existing.review,
        appointment_id: appointment_id ? Number(appointment_id) : existing.appointment_id,
      },
    });

    io?.emit('appointment-review-updated', updatedReview);

    res.json(updatedReview);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update appointment review' });
  }
});

/**
 * Delete appointment review
 */
router.delete('/:review_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const deleted = await prisma.appointment_reviews.delete({
      where: { review_id: Number(req.params.review_id) },
    });

    io?.emit('appointment-review-deleted', { review_id: deleted.review_id });

    res.json({ message: 'Appointment review deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete appointment review' });
  }
});

export default router;