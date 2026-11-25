import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/* GET ALL BOOKS */
router.get('/', async (_req, res) => {
  try {
    const books = await prisma.dg_content.findMany({
      where: {
        dg_categories: {
          dg_category_name: {
            equals: 'Books',
            mode: 'insensitive'
          }
        }
      },
      orderBy: { content_id: 'desc' },
      include: { dg_categories: true },
    });
    res.json(books);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch books' });
  }
});

/* GET BOOK BY ID */
router.get('/:id', async (req, res) => {
  try {
    const content_id = Number(req.params.id);
    if (Number.isNaN(content_id)) return res.status(400).json({ error: 'id must be a number' });
    const book = await prisma.dg_content.findUnique({
      where: { content_id },
      // NOTE: never embed dg_order here — this is a public (unauthenticated) detail route and
      // dg_order carries buyers' buyer_id / total / payment_method / Stripe payment_intent_id.
      include: { dg_categories: true },
    });
    if (!book) return res.status(404).json({ error: 'Book not found' });
    res.json(book);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch book' });
  }
});

/* POST CREATE BOOK ORDER (checkout)
   buyer_id is taken from the JWT (not the body) so a client can't place orders
   for someone else. ispaid starts false; the platform Stripe webhook flips it to
   true once the charge tied to payment_intent_id settles (same pattern as
   food/product/dg orders), so a paid book never lands as a reconciliation orphan. */
router.post('/orders', authenticateToken, async (req, res) => {
  try {
    const { content_id, qty, total, payment_method, payment_intent_id } = req.body;
    if (!content_id) return res.status(400).json({ error: 'content_id is required' });

    // The book's category is authoritative on the content row — derive it rather
    // than trusting a client-sent id (which would be env-specific and brittle).
    const content = await prisma.dg_content.findUnique({
      where: { content_id: Number(content_id) },
      select: { dg_category_id: true },
    });

    const order = await prisma.dg_order.create({
      data: {
        content_id: Number(content_id),
        buyer_id: req.user.user_id,
        qty: qty ? Number(qty) : 1,
        total: total != null ? Number(total) : null,
        ispaid: false,
        payment_method: payment_method ?? null,
        payment_intent_id: payment_intent_id ?? null,
        dg_category_id: content?.dg_category_id ?? null,
      },
    });
    res.status(201).json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create book order' });
  }
});

/* POST CREATE BOOK LISTING (seller) */
router.post('/listings', authenticateToken, async (req, res) => {
  try {
    const { content_title, content_description, price, cover_img_url, dg_category_id } = req.body;
    if (!content_title) return res.status(400).json({ error: 'content_title is required' });
    const listing = await prisma.dg_content.create({
      data: {
        content_title,
        content_description: content_description || null,
        // Seller identity is derived from the authenticated user, never the request body.
        // `author` is the seller key that GET /listings/:seller_id filters on.
        author: String(req.user.user_id),
        price: price ? Number(price) : null,
        cover_img_url: cover_img_url || null,
        dg_category_id: dg_category_id ? Number(dg_category_id) : null,
        date: new Date(),
      },
    });
    res.status(201).json(listing);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create book listing' });
  }
});

/* GET SELLER LISTINGS */
router.get('/listings/:seller_id', async (req, res) => {
  try {
    const author_id = Number(req.params.seller_id);
    if (Number.isNaN(author_id)) return res.status(400).json({ error: 'seller_id must be a number' });
    const listings = await prisma.dg_content.findMany({
      where: { author: String(author_id) },
      orderBy: { content_id: 'desc' },
      include: { dg_categories: true },
    });
    res.json(listings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch seller listings' });
  }
});

export default router;
