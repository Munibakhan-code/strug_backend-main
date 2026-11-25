import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/* GET ALL EXPERIENCES — browse by city/category */
router.get('/', async (req, res) => {
  try {
    const { category_id } = req.query;
    const where = category_id ? { rental_category_id: Number(category_id) } : {};
    const experiences = await prisma.rental_listing.findMany({
      where,
      orderBy: { rental_listing_id: 'desc' },
      include: { rental_categories: true, rental_type: true, rental_listing_pics: true, user: { select: { user_id: true, name: true } } },
    });
    res.json(experiences);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch experiences' });
  }
});

/* GET EXPERIENCE BY ID */
router.get('/:id', async (req, res) => {
  try {
    const rental_listing_id = Number(req.params.id);
    if (Number.isNaN(rental_listing_id)) return res.status(400).json({ error: 'id must be a number' });
    const experience = await prisma.rental_listing.findUnique({
      where: { rental_listing_id },
      include: {
        rental_categories: true,
        rental_type: true,
        rental_listing_pics: true,
        user: { select: { user_id: true, name: true } },
        rental_order: true,
      },
    });
    if (!experience) return res.status(404).json({ error: 'Experience not found' });
    res.json(experience);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch experience' });
  }
});

/* GET AVAILABLE SESSIONS FOR AN EXPERIENCE */
router.get('/:id/sessions', async (req, res) => {
  try {
    const rental_listing_id = Number(req.params.id);
    if (Number.isNaN(rental_listing_id)) return res.status(400).json({ error: 'id must be a number' });
    const orders = await prisma.rental_order.findMany({
      where: { rental_listing_id },
      select: { check_in: true, check_out: true },
      orderBy: { check_in: 'asc' },
    });
    res.json({ rental_listing_id, booked_slots: orders });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

/* POST BOOK AN EXPERIENCE */
router.post('/:id/book', authenticateToken, async (req, res) => {
  try {
    const rental_listing_id = Number(req.params.id);
    const { guest_id, check_in, check_out, total } = req.body;
    if (!guest_id) return res.status(400).json({ error: 'guest_id is required' });
    const order = await prisma.rental_order.create({
      data: {
        rental_listing_id,
        guest_id: Number(guest_id),
        check_in: check_in ? new Date(check_in) : new Date(),
        check_out: check_out ? new Date(check_out) : new Date(),
        total: total ? Number(total) : null,
        ispaid: false,
      },
    });
    res.status(201).json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to book experience' });
  }
});

export default router;
