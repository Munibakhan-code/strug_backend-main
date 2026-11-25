import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

function authUserId(req) {
  return Number(req.user?.user_id);
}

function isAdmin(req) {
  const role = String(req.user?.role || req.user?.permission || '').toUpperCase();
  return role === 'ADMIN' || role === 'BOARD';
}

async function serverCartTotal(contentId, qty) {
  const content = await prisma.dg_content.findUnique({
    where: { content_id: Number(contentId) },
    select: { price: true, dg_category_id: true },
  });
  if (!content) return null;
  const q = Number(qty);
  if (!Number.isFinite(q) || q <= 0) return null;
  const unit = Number(content.price);
  if (!Number.isFinite(unit) || unit < 0) return null;
  return {
    total: Math.round(unit * q * 100) / 100,
    dg_category_id: content.dg_category_id ?? null,
  };
}

/**
 * List DG cart items for the JWT user only (admins may list all).
 * Unscoped findMany previously leaked every buyer's cart across accounts.
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const where = isAdmin(req) ? {} : { buyer_id: authUserId(req) };
    const carts = await prisma.dg_cart.findMany({
      where,
      orderBy: { cart_id: 'desc' },
      include: {
        user: true,
        dg_content: true,
        dg_categories: true,
      },
    });

    res.json(carts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch DG cart items' });
  }
});

/**
 * Get single DG cart item (owner or admin).
 */
router.get('/:cart_id', authenticateToken, async (req, res) => {
  try {
    const cart = await prisma.dg_cart.findUnique({
      where: { cart_id: Number(req.params.cart_id) },
      include: {
        user: true,
        dg_content: true,
        dg_categories: true,
      },
    });

    if (!cart) return res.status(404).json({ error: 'DG cart item not found' });
    if (!isAdmin(req) && cart.buyer_id !== authUserId(req)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json(cart);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch DG cart item' });
  }
});

/**
 * Create DG cart item — buyer_id from JWT only; total from catalog price × qty.
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { content_id, qty, dg_category_id } = req.body;
    const buyer_id = authUserId(req);

    if (!buyer_id || !content_id || qty == null) {
      return res.status(400).json({ error: 'content_id and qty are required' });
    }

    const priced = await serverCartTotal(content_id, qty);
    if (!priced) {
      return res.status(400).json({ error: 'Invalid content_id or qty' });
    }

    const newCart = await prisma.dg_cart.create({
      data: {
        content_id: Number(content_id),
        buyer_id,
        qty: Number(qty),
        total: priced.total,
        dg_category_id: dg_category_id ?? priced.dg_category_id,
      },
    });

    io?.to(`user-${buyer_id}`).emit('dg-cart-created', newCart);

    res.status(201).json(newCart);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create DG cart item' });
  }
});

/**
 * Update DG cart item — owner only; ignore client buyer_id / total.
 */
router.put('/:cart_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { cart_id } = req.params;
    const { content_id, qty, dg_category_id } = req.body;

    const existing = await prisma.dg_cart.findUnique({
      where: { cart_id: Number(cart_id) },
    });

    if (!existing) return res.status(404).json({ error: 'DG cart item not found' });
    if (!isAdmin(req) && existing.buyer_id !== authUserId(req)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const nextContentId = content_id ?? existing.content_id;
    const nextQty = qty ?? existing.qty;
    const priced = await serverCartTotal(nextContentId, nextQty);
    if (!priced) {
      return res.status(400).json({ error: 'Invalid content_id or qty' });
    }

    const updatedCart = await prisma.dg_cart.update({
      where: { cart_id: Number(cart_id) },
      data: {
        content_id: Number(nextContentId),
        // Never reassign buyer_id from the client (profile / wallet takeover).
        qty: Number(nextQty),
        total: priced.total,
        dg_category_id: dg_category_id ?? priced.dg_category_id ?? existing.dg_category_id,
      },
    });

    io?.to(`user-${existing.buyer_id}`).emit('dg-cart-updated', updatedCart);

    res.json(updatedCart);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update DG cart item' });
  }
});

/**
 * Delete DG cart item — owner or admin.
 */
router.delete('/:cart_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const existing = await prisma.dg_cart.findUnique({
      where: { cart_id: Number(req.params.cart_id) },
    });
    if (!existing) return res.status(404).json({ error: 'DG cart item not found' });
    if (!isAdmin(req) && existing.buyer_id !== authUserId(req)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const deleted = await prisma.dg_cart.delete({
      where: { cart_id: Number(req.params.cart_id) },
    });

    io?.to(`user-${deleted.buyer_id}`).emit('dg-cart-deleted', { cart_id: deleted.cart_id });

    res.json({ message: 'DG cart item deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete DG cart item' });
  }
});

export default router;
