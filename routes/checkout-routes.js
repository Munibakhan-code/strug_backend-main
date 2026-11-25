import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { requireAdmin } from '../middleware/require-admin.js';

const router = express.Router();

// `checkouts` are finance/reporting aggregate rows (consumed by ads-analytics) with a
// client-writable `total` and no per-user owner column. They must never be mutated by
// arbitrary users — every read AND write is admin-only.

/**
 * Get all checkouts — admin only
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const admin = await Promise.resolve(req.user.permission === 'admin' ? true : null);
    if (!admin) return res.status(403).json({ error: 'Admin access required' });

    const checkouts = await prisma.checkouts.findMany({
      orderBy: { checkout_id: 'desc' },
      include: {
        categories: true,
        shared_ref_code: true,
        appointments: true,
        cam_post_order: true,
        courier_order: true,
        dg_order: true,
        product_order: true,
        rental_order: true,
        service_order: true,
      },
    });

    res.json(checkouts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch checkouts' });
  }
});

/**
 * Get single checkout — admin only
 */
router.get('/:checkout_id', authenticateToken, async (req, res) => {
  try {
    const admin = await Promise.resolve(req.user.permission === 'admin' ? true : null);
    if (!admin) return res.status(403).json({ error: 'Admin access required' });

    const checkout = await prisma.checkouts.findUnique({
      where: { checkout_id: Number(req.params.checkout_id) },
      include: {
        categories: true,
        shared_ref_code: true,
        appointments: true,
        cam_post_order: true,
        courier_order: true,
        dg_order: true,
        product_order: true,
        rental_order: true,
        service_order: true,
      },
    });

    if (!checkout)
      return res.status(404).json({ error: 'Checkout not found' });

    res.json(checkout);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch checkout' });
  }
});

/**
 * Create checkout
 */
router.post('/', authenticateToken, requireAdmin, async (req, res) => {
  const io = req.app.get('io');

  try {
    const {
      total,
      share_id,
      date,
      category_id,
    } = req.body;

    const checkout = await prisma.checkouts.create({
      data: {
        total,
        share_id,
        date: date ? new Date(date) : new Date(),
        category_id,
      },
    });

    io?.emit('checkout-created', checkout);

    res.status(201).json(checkout);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create checkout' });
  }
});

/**
 * Update checkout
 */
router.put('/:checkout_id', authenticateToken, requireAdmin, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { checkout_id } = req.params;
    const {
      total,
      share_id,
      date,
      category_id,
    } = req.body;

    const existing = await prisma.checkouts.findUnique({
      where: { checkout_id: Number(checkout_id) },
    });

    if (!existing)
      return res.status(404).json({ error: 'Checkout not found' });

    const updatedCheckout = await prisma.checkouts.update({
      where: { checkout_id: Number(checkout_id) },
      data: {
        total,
        share_id,
        date: date ? new Date(date) : existing.date,
        category_id,
      },
    });

    io?.emit('checkout-updated', updatedCheckout);

    res.json(updatedCheckout);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update checkout' });
  }
});

/**
 * Delete checkout
 */
router.delete('/:checkout_id', authenticateToken, requireAdmin, async (req, res) => {
  const io = req.app.get('io');

  try {
    const deleted = await prisma.checkouts.delete({
      where: { checkout_id: Number(req.params.checkout_id) },
    });

    io?.emit('checkout-deleted', {
      checkout_id: deleted.checkout_id,
    });

    res.json({ message: 'Checkout deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete checkout' });
  }
});

export default router;
