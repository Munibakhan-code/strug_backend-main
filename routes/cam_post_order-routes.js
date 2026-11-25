// routes/camPostOrder.js
import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/**
 * Get all cam post orders
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const orders = await prisma.cam_post_order.findMany({
      orderBy: { cam_post_order_id: 'desc' },
      include: {
        cam_post: true,
        checkouts: true,
        user: true,
      },
    });

    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch cam post orders' });
  }
});

/**
 * Get single cam post order
 */
router.get('/:cam_post_order_id', authenticateToken, async (req, res) => {
  try {
    const order = await prisma.cam_post_order.findUnique({
      where: { cam_post_order_id: Number(req.params.cam_post_order_id) },
      include: {
        cam_post: true,
        checkouts: true,
        user: true,
      },
    });

    if (!order) return res.status(404).json({ error: 'Cam post order not found' });

    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch cam post order' });
  }
});

/**
 * Create new cam post order
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const {
      cam_post_id,
      user_id,
      duration,
      status,
      order_time,
      delivered_time,
      checkout_id,
    } = req.body;

    if (!cam_post_id || !user_id || !duration) {
      return res.status(400).json({ error: 'cam_post_id, user_id and duration are required' });
    }

    const newOrder = await prisma.cam_post_order.create({
      data: {
        cam_post_id: Number(cam_post_id),
        user_id: Number(user_id),
        duration: Number(duration),
        status: status ?? 'pending',
        order_time: order_time ? new Date(order_time) : new Date(),
        delivered_time: delivered_time ? new Date(delivered_time) : null,
        checkout_id: checkout_id ? Number(checkout_id) : null,
      },
    });

    io?.emit('cam-post-order-created', newOrder);

    res.status(201).json(newOrder);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create cam post order' });
  }
});

/**
 * Update cam post order
 */
router.put('/:cam_post_order_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { cam_post_order_id } = req.params;
    const {
      cam_post_id,
      user_id,
      duration,
      status,
      order_time,
      delivered_time,
      checkout_id,
    } = req.body;

    const existing = await prisma.cam_post_order.findUnique({
      where: { cam_post_order_id: Number(cam_post_order_id) },
    });

    if (!existing) return res.status(404).json({ error: 'Cam post order not found' });

    const updatedOrder = await prisma.cam_post_order.update({
      where: { cam_post_order_id: Number(cam_post_order_id) },
      data: {
        cam_post_id: cam_post_id ? Number(cam_post_id) : existing.cam_post_id,
        user_id: user_id ? Number(user_id) : existing.user_id,
        duration: duration ? Number(duration) : existing.duration,
        status: status ?? existing.status,
        order_time: order_time ? new Date(order_time) : existing.order_time,
        delivered_time: delivered_time ? new Date(delivered_time) : existing.delivered_time,
        checkout_id: checkout_id ? Number(checkout_id) : existing.checkout_id,
      },
    });

    io?.emit('cam-post-order-updated', updatedOrder);

    res.json(updatedOrder);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update cam post order' });
  }
});

/**
 * Delete cam post order
 */
router.delete('/:cam_post_order_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const deleted = await prisma.cam_post_order.delete({
      where: { cam_post_order_id: Number(req.params.cam_post_order_id) },
    });

    io?.emit('cam-post-order-deleted', { cam_post_order_id: deleted.cam_post_order_id });

    res.json({ message: 'Cam post order deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete cam post order' });
  }
});

export default router;