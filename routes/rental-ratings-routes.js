import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

const LIST_TAKE_MAX = 100;

function clampTake(raw, fallback = 50) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), LIST_TAKE_MAX);
}

/* GET ALL RENTAL RATINGS — auth required; paginated */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const take = clampTake(req.query.take, 50);
    const skip = Math.max(0, Number(req.query.skip) || 0);
    const ratings = await prisma.rental_ratings.findMany({
      orderBy: { rating_id: 'desc' },
      take,
      skip,
      include: {
        user: { select: { user_id: true, name: true, username: true } },
        rental_order: {
          include: {
            rental_listing: true,
          },
        },
        rental_type: true,
      },
    });
    res.json(ratings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch rental ratings' });
  }
});

/* GET RATINGS BY ORDER ID — parties on the order only */
router.get('/order/:order_id', authenticateToken, async (req, res) => {
  try {
    const order_id = Number(req.params.order_id);
    if (Number.isNaN(order_id)) return res.status(400).json({ error: 'order_id must be a number' });

    const order = await prisma.rental_order.findUnique({
      where: { order_id },
      select: {
        buyer_id: true,
        rental_listing: { select: { owner_id: true } },
      },
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const uid = req.user.user_id;
    const ownerId = order.rental_listing?.owner_id;
    if (order.buyer_id !== uid && ownerId !== uid) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const ratings = await prisma.rental_ratings.findMany({
      where: { order_id },
      include: {
        user: { select: { user_id: true, name: true, username: true } },
        rental_type: true,
      },
    });
    res.json(ratings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch ratings for order' });
  }
});

/* GET RATINGS BY BUYER — self only */
router.get('/buyer/:buyer_id', authenticateToken, async (req, res) => {
  try {
    const buyer_id = Number(req.params.buyer_id);
    if (Number.isNaN(buyer_id)) return res.status(400).json({ error: 'buyer_id must be a number' });
    if (buyer_id !== req.user.user_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const take = clampTake(req.query.take, 50);
    const ratings = await prisma.rental_ratings.findMany({
      where: { buyer_id },
      orderBy: { rating_id: 'desc' },
      take,
      include: {
        rental_order: {
          include: {
            rental_listing: true,
          },
        },
        rental_type: true,
      },
    });
    res.json(ratings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch ratings by buyer' });
  }
});

/* ADD RENTAL RATING — buyer_id from JWT; must own the order */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const order_id = Number(req.body.order_id);
    const rating = Number(req.body.rating);
    const rental_type_id = req.body.rental_type_id != null ? Number(req.body.rental_type_id) : null;
    const feedback = req.body.feedback == null || req.body.feedback === ''
      ? null
      : String(req.body.feedback).slice(0, 2000);
    const buyer_id = req.user.user_id;

    if (!Number.isFinite(order_id)) {
      return res.status(400).json({ error: 'order_id must be a number' });
    }
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'rating must be a number between 1 and 5' });
    }

    const order = await prisma.rental_order.findUnique({
      where: { order_id },
      select: { buyer_id: true },
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.buyer_id !== buyer_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const existing = await prisma.rental_ratings.findFirst({
      where: { order_id, buyer_id },
    });
    if (existing) {
      return res.status(409).json({ error: 'You already rated this order' });
    }

    const newRating = await prisma.rental_ratings.create({
      data: {
        order_id,
        buyer_id,
        rating,
        feedback,
        rental_type_id: Number.isFinite(rental_type_id) ? rental_type_id : undefined,
      },
      include: {
        user: { select: { user_id: true, name: true, username: true } },
        rental_order: true,
        rental_type: true,
      },
    });

    res.status(201).json(newRating);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add rental rating' });
  }
});

/* UPDATE RENTAL RATING — owner only (FIXED WITH VALIDATION) */
router.put('/:rating_id', authenticateToken, async (req, res) => {
  try {
    const rating_id = Number(req.params.rating_id);
    if (Number.isNaN(rating_id)) return res.status(400).json({ error: 'rating_id must be a number' });

    const existing = await prisma.rental_ratings.findUnique({ where: { rating_id } });
    if (!existing) return res.status(404).json({ error: 'Rating not found' });
    if (existing.buyer_id !== req.user.user_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { rating, feedback, rental_type_id } = req.body;

    // 1. Rating Validation (1 to 5)
    let ratingNum = existing.rating;
    if (rating !== undefined) {
      ratingNum = Number(rating);
      if (!Number.isFinite(ratingNum) || ratingNum < 1 || ratingNum > 5) {
        return res.status(400).json({ error: 'rating must be a number between 1 and 5' });
      }
    }

    // 2. Feedback Length Limit (Max 2000 chars)
    const feedbackText = feedback !== undefined
      ? (feedback == null || feedback === '' ? null : String(feedback).slice(0, 2000))
      : existing.feedback;

    const updated = await prisma.rental_ratings.update({
      where: { rating_id },
      data: {
        rating: ratingNum,
        feedback: feedbackText,
        rental_type_id: rental_type_id ?? existing.rental_type_id,
      },
      include: {
        user: { select: { user_id: true, name: true, username: true } },
        rental_order: true,
        rental_type: true,
      },
    });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update rental rating' });
  }
});

/* DELETE RENTAL RATING — owner only */
router.delete('/:rating_id', authenticateToken, async (req, res) => {
  try {
    const rating_id = Number(req.params.rating_id);
    if (Number.isNaN(rating_id)) return res.status(400).json({ error: 'rating_id must be a number' });

    const existing = await prisma.rental_ratings.findUnique({ where: { rating_id } });
    if (!existing) return res.status(404).json({ error: 'Rating not found' });
    if (existing.buyer_id !== req.user.user_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await prisma.rental_ratings.delete({ where: { rating_id } });
    res.json({ message: 'Rental rating deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete rental rating' });
  }
});

export default router;
