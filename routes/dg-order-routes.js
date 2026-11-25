import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/* GET ALL DG ORDERS — scoped to JWT user's purchases */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const orders = await prisma.dg_order.findMany({
      where: { buyer_id: req.user.user_id },
      orderBy: { order_id: 'desc' },
      include: {
        user: true,
        dg_content: true,
        dg_categories: true,
        checkouts: true,
      },
    });

    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch DG orders' });
  }
});

/* GET SINGLE DG ORDER — buyer only */
router.get('/:order_id', authenticateToken, async (req, res) => {
  try {
    const order = await prisma.dg_order.findUnique({
      where: { order_id: Number(req.params.order_id) },
      include: {
        user: true,
        dg_content: true,
        dg_categories: true,
        checkouts: true,
      },
    });

    if (!order) return res.status(404).json({ error: 'DG order not found' });

    if (order.buyer_id !== req.user.user_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch DG order' });
  }
});

/* CREATE DG ORDER — buyer_id set from JWT; ispaid always false on creation */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const {
      content_id,
      qty,
      date,
      payment_method,
      payment_intent_id,
      expire_date,
      dg_category_id,
      checkout_id,
    } = req.body;

    if (!content_id || !qty) {
      return res.status(400).json({ error: 'content_id and qty are required' });
    }

    // Catalog price is authoritative — ignore client total (wallet / order attribution).
    const content = await prisma.dg_content.findUnique({
      where: { content_id: Number(content_id) },
      select: { dg_category_id: true, price: true },
    });
    if (!content) {
      return res.status(400).json({ error: 'Invalid content_id' });
    }
    const q = Number(qty);
    const unit = Number(content.price);
    if (!Number.isFinite(q) || q <= 0 || !Number.isFinite(unit) || unit < 0) {
      return res.status(400).json({ error: 'Invalid qty or catalog price' });
    }
    const serverTotal = Math.round(unit * q * 100) / 100;
    const resolvedCategoryId = dg_category_id ?? content.dg_category_id ?? null;

    const newOrder = await prisma.dg_order.create({
      data: {
        content_id,
        buyer_id: req.user.user_id,
        total: serverTotal,
        qty: q,
        date: date ? new Date(date) : new Date(),
        // ispaid starts false; the platform Stripe webhook flips it to true once
        // the charge tied to payment_intent_id settles (reconcilePlatformPayment).
        ispaid: false,
        payment_method,
        payment_intent_id: payment_intent_id ?? null,
        expire_date: expire_date ? new Date(expire_date) : null,
        dg_category_id: resolvedCategoryId,
        checkout_id,
      },
    });

    // REMOVED: `io?.emit('dg-order-created', newOrder)`.
    //
    // A bare io.emit has no room, so it fanned the WHOLE order row out to every connected
    // socket on the server — buyer_id, total, payment_method and the Stripe `payment_intent_id`
    // — to every logged-in user on Strug. Nothing consumed it: there is no listener for
    // `dg-order-created` in any frontend (SPA, internal dashboards, web app, landing). It was a
    // pure liability, so it's gone rather than re-scoped to a room nobody subscribes to.
    //
    // The seller SHOULD be told about a new order. That belongs in Epic 10's notify() service,
    // which persists a row and emits the single `notification:new` into the seller's `user-<id>`
    // room — not in an unscoped broadcast of a raw DB record.

    res.status(201).json(newOrder);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create DG order' });
  }
});

/* UPDATE DG ORDER — buyer only; ispaid not updatable via this route */
router.put('/:order_id', authenticateToken, async (req, res) => {
  try {
    const { order_id } = req.params;
    const {
      content_id,
      qty,
      date,
      payment_method,
      expire_date,
      dg_category_id,
      checkout_id,
    } = req.body;

    const existing = await prisma.dg_order.findUnique({
      where: { order_id: Number(order_id) },
    });

    if (!existing) return res.status(404).json({ error: 'DG order not found' });

    if (existing.buyer_id !== req.user.user_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (existing.ispaid === true) {
      return res.status(400).json({ error: 'Paid digital orders cannot be modified.' });
    }

    const nextContentId = content_id ?? existing.content_id;
    const nextQty = qty ?? existing.qty;
    let nextTotal = existing.total;
    if (content_id != null || qty != null) {
      const content = await prisma.dg_content.findUnique({
        where: { content_id: Number(nextContentId) },
        select: { price: true, dg_category_id: true },
      });
      if (!content) return res.status(400).json({ error: 'Invalid content_id' });
      const q = Number(nextQty);
      const unit = Number(content.price);
      if (!Number.isFinite(q) || q <= 0 || !Number.isFinite(unit) || unit < 0) {
        return res.status(400).json({ error: 'Invalid qty or catalog price' });
      }
      nextTotal = Math.round(unit * q * 100) / 100;
    }

    const updatedOrder = await prisma.dg_order.update({
      where: { order_id: Number(order_id) },
      data: {
        content_id: nextContentId,
        // Ignore client total — catalog price × qty only.
        total: nextTotal,
        qty: nextQty,
        date: date ? new Date(date) : existing.date,
        payment_method: payment_method ?? existing.payment_method,
        expire_date: expire_date ? new Date(expire_date) : existing.expire_date,
        dg_category_id: dg_category_id ?? existing.dg_category_id,
        checkout_id: checkout_id ?? existing.checkout_id,
      },
    });

    // REMOVED for the same reason as the create emit above: an unscoped io.emit broadcasts the
    // whole order row (incl. `payment_intent_id`) to every connected socket, and nothing listens
    // for `dg-order-updated` in any frontend. Order-status realtime belongs in notify().

    res.json(updatedOrder);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update DG order' });
  }
});

/* DELETE DG ORDER — buyer only; unpaid only */
router.delete('/:order_id', authenticateToken, async (req, res) => {
  try {
    const existing = await prisma.dg_order.findUnique({
      where: { order_id: Number(req.params.order_id) },
    });

    if (!existing) return res.status(404).json({ error: 'DG order not found' });

    if (existing.buyer_id !== req.user.user_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (existing.ispaid === true) {
      return res.status(400).json({ error: 'Paid digital orders cannot be deleted.' });
    }

    await prisma.dg_order.delete({
      where: { order_id: Number(req.params.order_id) },
    });

    // No unscoped io.emit of order ids / payment metadata.

    res.json({ message: 'DG order deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete DG order' });
  }
});

export default router;
