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

/* GET ALL SERVICE RATINGS — auth required; paginated */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const take = clampTake(req.query.take, 50);
    const skip = Math.max(0, Number(req.query.skip) || 0);
    const serviceRatings = await prisma.service_ratings.findMany({
      orderBy: { rating_id: 'desc' },
      take,
      skip,
      include: {
        user: { select: { user_id: true, name: true, username: true } },
        service_order: true,
        user_service_provider: true,
        service_type: true,
      },
    });

    res.json(serviceRatings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch service ratings' });
  }
});

/* GET SERVICE RATING BY ID */
router.get('/:rating_id', authenticateToken, async (req, res) => {
  try {
    const rating_id = Number(req.params.rating_id);

    if (Number.isNaN(rating_id)) {
      return res.status(400).json({ error: 'rating_id must be a number' });
    }

    const serviceRating = await prisma.service_ratings.findUnique({
      where: { rating_id },
      include: {
        user: { select: { user_id: true, name: true, username: true } },
        service_order: true,
        user_service_provider: true,
        service_type: true,
      },
    });

    if (!serviceRating) {
      return res.status(404).json({ error: 'Service rating not found' });
    }

    res.json(serviceRating);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch service rating' });
  }
});

/* CREATE SERVICE RATING — buyer_id from JWT */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const {
      provider_id,
      order_id,
      rating,
      feedback,
      service_type_id,
    } = req.body;
    const buyer_id = req.user.user_id;

    const ratingNum = Number(rating);
    if (!Number.isFinite(ratingNum) || ratingNum < 1 || ratingNum > 5) {
      return res.status(400).json({ error: 'rating must be a number between 1 and 5' });
    }

    if (order_id != null) {
      const oid = Number(order_id);
      if (!Number.isFinite(oid)) {
        return res.status(400).json({ error: 'order_id must be a number' });
      }
      const order = await prisma.service_order.findUnique({
        where: { order_id: oid },
        select: { buyer_id: true },
      });
      if (!order) return res.status(404).json({ error: 'Order not found' });
      if (order.buyer_id !== buyer_id) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    const serviceRating = await prisma.service_ratings.create({
      data: {
        provider_id: provider_id != null ? Number(provider_id) : undefined,
        order_id: order_id != null ? Number(order_id) : undefined,
        buyer_id,
        rating: ratingNum,
        feedback: feedback == null || feedback === '' ? null : String(feedback).slice(0, 2000),
        service_type_id: service_type_id != null ? Number(service_type_id) : undefined,
      },
      include: {
        user: { select: { user_id: true, name: true, username: true } },
        service_order: true,
        user_service_provider: true,
        service_type: true,
      },
    });

    res.status(201).json(serviceRating);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create service rating' });
  }
});

/* UPDATE SERVICE RATING — owner only (FIXED WITH VALIDATION) */
router.put('/:rating_id', authenticateToken, async (req, res) => {
  try {
    const rating_id = Number(req.params.rating_id);

    if (Number.isNaN(rating_id)) {
      return res.status(400).json({ error: 'rating_id must be a number' });
    }

    const existing = await prisma.service_ratings.findUnique({
      where: { rating_id },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Service rating not found' });
    }
    if (existing.buyer_id !== req.user.user_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const {
      provider_id,
      order_id,
      rating,
      feedback,
      service_type_id,
    } = req.body;

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

    const updated = await prisma.service_ratings.update({
      where: { rating_id },
      data: {
        provider_id: provider_id ?? existing.provider_id,
        order_id: order_id ?? existing.order_id,
        rating: ratingNum,
        feedback: feedbackText,
        service_type_id: service_type_id ?? existing.service_type_id,
      },
      include: {
        user: { select: { user_id: true, name: true, username: true } },
        service_order: true,
        user_service_provider: true,
        service_type: true,
      },
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update service rating' });
  }
});

/* DELETE SERVICE RATING — owner only */
router.delete('/:rating_id', authenticateToken, async (req, res) => {
  try {
    const rating_id = Number(req.params.rating_id);

    if (Number.isNaN(rating_id)) {
      return res.status(400).json({ error: 'rating_id must be a number' });
    }

    const existing = await prisma.service_ratings.findUnique({ where: { rating_id } });
    if (!existing) {
      return res.status(404).json({ error: 'Service rating not found' });
    }
    if (existing.buyer_id !== req.user.user_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await prisma.service_ratings.delete({
      where: { rating_id },
    });

    res.json({ message: 'Service rating deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete service rating' });
  }
});

export default router;
