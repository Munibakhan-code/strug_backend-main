import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { z } from 'zod';
import { requireAuthUserId, assertPassengerOwnsTrip } from '../utils/ride-auth.js';

const router = express.Router();

const ratingSchema = z.object({
  trip_id: z.number().int(),
  rating: z.number().min(1).max(5),
  review: z.string().optional()
});

router.post('/', authenticateToken, async (req, res) => {
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const validated = ratingSchema.safeParse(req.body);
    if (!validated.success) return res.status(400).json({ successful: false, errors: (validated.error.issues ?? validated.error.errors) });

    const { trip_id, rating, review } = validated.data;

    const trip = await prisma.active_trip.findUnique({
      where: { trip_id },
      include: { ride_rating: true, ride_request: true },
    });

    if (!trip || !trip.ended_at) {
      return res.status(400).json({ successful: false, message: 'Trip must be completed before rating' });
    }

    if (trip.ride_request?.status !== 'completed') {
      return res.status(400).json({ successful: false, message: 'Ride must be completed before rating' });
    }

    const denied = await assertPassengerOwnsTrip(prisma, trip, userId);
    if (denied) return res.status(denied.status).json({ successful: false, message: denied.message });

    const existingRating = await prisma.ride_rating.findUnique({ where: { trip_id } });
    if (existingRating) {
      return res.status(400).json({ successful: false, message: 'Rating already submitted for this trip' });
    }

    const newRating = await prisma.ride_rating.create({
      data: {
        user_id: userId,
        trip_id,
        rating,
        review,
      },
    });

    return res.status(201).json({ successful: true, data: newRating });

  } catch (err) {
    console.error('Rating Error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

export default router;
