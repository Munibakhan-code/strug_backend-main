import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/* GET ALL RENTAL ORDERS — scoped to JWT user's bookings */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const rentalOrders = await prisma.rental_order.findMany({
      where: { buyer_id: req.user.user_id },
      orderBy: { order_id: 'desc' },
      include: {
        user: true,
        checkouts: true,
        rental_listing: true,
        rental_type: true,
        rental_ratings: true,
      },
    });

    res.json(rentalOrders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch rental orders' });
  }
});

/* GET RENTAL ORDER BY ID — buyer or listing owner only */
router.get('/:order_id', authenticateToken, async (req, res) => {
  try {
    const order_id = Number(req.params.order_id);

    if (Number.isNaN(order_id)) {
      return res.status(400).json({ error: 'order_id must be a number' });
    }

    const rentalOrder = await prisma.rental_order.findUnique({
      where: { order_id },
      include: {
        user: true,
        checkouts: true,
        rental_listing: { include: { user: true } },
        rental_type: true,
        rental_ratings: true,
      },
    });

    if (!rentalOrder) {
      return res.status(404).json({ error: 'Rental order not found' });
    }

    const uid = req.user.user_id;
    const isBuyer = rentalOrder.buyer_id === uid;
    const isHost = rentalOrder.rental_listing?.user_id === uid;
    if (!isBuyer && !isHost) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json(rentalOrder);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch rental order' });
  }
});

/* GET RENTAL ORDERS BY BUYER — scoped to JWT user regardless of URL param */
router.get('/buyer/:buyer_id', authenticateToken, async (req, res) => {
  try {
    const rentalOrders = await prisma.rental_order.findMany({
      where: { buyer_id: req.user.user_id },
      orderBy: { date: 'desc' },
      include: {
        rental_listing: true,
        rental_type: true,
      },
    });

    res.json(rentalOrders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch rental orders for buyer' });
  }
});

/* CREATE RENTAL ORDER — buyer_id set from JWT; ispaid always false on creation */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const {
      rental_listing_id,
      listing_id,
      total,
      qty,
      date,
      payment_method,
      expire_date,
      rental_type_id,
      checkout_id,
    } = req.body;

    

    const listingId = rental_listing_id ?? listing_id ?? null;

    let autoConfirm = false;
    if (listingId) {
      const listing = await prisma.rental_listing.findUnique({
        where: { rental_listing_id: Number(listingId) },
        select: { instant_booking: true, owner_id: true },
      }).catch(() => null);
      autoConfirm = listing?.instant_booking === true;
    }


    const rentalOrder = await prisma.rental_order.create({
      data: {
        rental_listing_id: listingId ? Number(listingId) : null,
        buyer_id: req.user.user_id,
        total,
        qty,
        date: date ? new Date(date) : new Date(),
        ispaid: false,
        payment_method,
        expire_date: expire_date ? new Date(expire_date) : undefined,
        rental_type_id,
        checkout_id,
        status: autoConfirm ? 'confirmed' : 'pending',
      },
      include: {
        user: true,
        rental_listing: true,
        rental_type: true,
      },
    });

    const io = req.app.get('io');
    const hostUserId = rentalOrder.rental_listing?.owner_id;
    if (io && hostUserId) {
      io.to(`user-${hostUserId}`).emit(`notification_user_${hostUserId}`, {
        type: 'new-booking',
        message: `New booking for "${rentalOrder.rental_listing?.rental_listing_name ?? 'your listing'}"`,
        orderId: rentalOrder.order_id,
        guestName: rentalOrder.user?.name ?? rentalOrder.user?.username ?? 'Guest',
        amount: rentalOrder.total,
        instant: autoConfirm,
      });
    }

    if (hostUserId) {
      const activeAd = await prisma.ads_campaign.findFirst({
        where: { advertiser_id: hostUserId, status: "ACTIVE" },
      });
      if (activeAd) {
        const { trackAdEvent } = await import('../utils/ads-delivery-engine.js');
        await trackAdEvent(
          activeAd.campaign_id,
          "impression",
          req.user.profile_id,
          req.ip || "127.0.0.1",
          io
        ).catch(() => null);
      }
    }
    res.status(201).json(rentalOrder);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create rental order' });
  }
});

/* UPDATE RENTAL ORDER — buyer or host only; ispaid not updatable via this route */
router.put('/:order_id', authenticateToken, async (req, res) => {
  try {
    const order_id = Number(req.params.order_id);

    if (Number.isNaN(order_id)) {
      return res.status(400).json({ error: 'order_id must be a number' });
    }

    const existing = await prisma.rental_order.findUnique({
      where: { order_id },
      include: { rental_listing: { select: { user_id: true } } },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Rental order not found' });
    }

    const uid = req.user.user_id;
    if (existing.buyer_id !== uid && existing.rental_listing?.user_id !== uid) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const {
      rental_listing_id,
      total,
      qty,
      date,
      payment_method,
      expire_date,
      rental_type_id,
      checkout_id,
    } = req.body;

    const updated = await prisma.rental_order.update({
      where: { order_id },
      data: {
        rental_listing_id: rental_listing_id ?? existing.rental_listing_id,
        total: total ?? existing.total,
        qty: qty ?? existing.qty,
        date: date ? new Date(date) : existing.date,
        payment_method: payment_method ?? existing.payment_method,
        expire_date: expire_date ? new Date(expire_date) : existing.expire_date,
        rental_type_id: rental_type_id ?? existing.rental_type_id,
        checkout_id: checkout_id ?? existing.checkout_id,
      },
      include: {
        user: true,
        checkouts: true,
        rental_listing: true,
        rental_type: true,
        rental_ratings: true,
      },
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update rental order' });
  }
});

/* DELETE RENTAL ORDER — buyer only */
router.delete('/:order_id', authenticateToken, async (req, res) => {
  try {
    const order_id = Number(req.params.order_id);

    if (Number.isNaN(order_id)) {
      return res.status(400).json({ error: 'order_id must be a number' });
    }

    const existing = await prisma.rental_order.findUnique({ where: { order_id } });
    if (!existing) return res.status(404).json({ error: 'Rental order not found' });
    if (existing.buyer_id !== req.user.user_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await prisma.rental_order.delete({ where: { order_id } });

    res.json({ message: 'Rental order deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete rental order' });
  }
});

/* PUT /:order_id/accept — provider accepts rental booking */
router.put('/:order_id/accept', authenticateToken, async (req, res) => {
  try {
    const order_id = Number(req.params.order_id);
    const order = await prisma.rental_order.findUnique({ where: { order_id } });
    if (!order) return res.status(404).json({ successful: false, message: 'Order not found' });
    if (order.status !== 'pending') return res.status(400).json({ successful: false, message: 'Order no longer pending' });

    await prisma.rental_order.update({ where: { order_id }, data: { status: 'confirmed' } });
    return res.json({ successful: true, message: 'Rental booking confirmed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/* PUT /:order_id/decline — provider declines rental booking */
router.put('/:order_id/decline', authenticateToken, async (req, res) => {
  try {
    const order_id = Number(req.params.order_id);
    const order = await prisma.rental_order.findUnique({ where: { order_id } });
    if (!order) return res.status(404).json({ successful: false, message: 'Order not found' });
    if (order.status !== 'pending') return res.status(400).json({ successful: false, message: 'Order no longer pending' });

    await prisma.rental_order.update({ where: { order_id }, data: { status: 'declined' } });
    return res.json({ successful: true, message: 'Rental booking declined' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/* PATCH /:order_id/start */
router.patch('/:order_id/start', authenticateToken, async (req, res) => {
  try {
    const order_id = Number(req.params.order_id);
    const order = await prisma.rental_order.findUnique({ where: { order_id } });
    if (!order) return res.status(404).json({ successful: false, message: 'Order not found' });
    if (order.status !== 'accepted') return res.status(400).json({ successful: false, message: 'Order must be accepted before starting' });

    await prisma.rental_order.update({ where: { order_id }, data: { status: 'in_progress' } });
    const io = req.app.get('io');
    io?.to(`user-${order.buyer_id}`).emit(`rental-started-${order_id}`, { message: 'Rental has started' });
    return res.json({ successful: true, message: 'Rental started' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/* PATCH /:order_id/complete */
router.patch('/:order_id/complete', authenticateToken, async (req, res) => {
  try {
    const order_id = Number(req.params.order_id);
    const order = await prisma.rental_order.findUnique({ where: { order_id } });
    if (!order) return res.status(404).json({ successful: false, message: 'Order not found' });
    if (order.status !== 'in_progress') return res.status(400).json({ successful: false, message: 'Order must be in_progress before completing' });

    await prisma.rental_order.update({ where: { order_id }, data: { status: 'completed' } });
    const io = req.app.get('io');
    io?.to(`user-${order.buyer_id}`).emit(`rental-completed-${order_id}`, { message: 'Rental completed' });
    return res.json({ successful: true, message: 'Rental completed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/* PATCH /:order_id/pay — marks rental order as paid after payment confirmation */
router.patch('/:order_id/pay', authenticateToken, async (req, res) => {
  try {
    const order_id = Number(req.params.order_id);
    const order = await prisma.rental_order.findUnique({ where: { order_id } });
    if (!order) return res.status(404).json({ successful: false, message: 'Order not found' });
    if (order.buyer_id !== req.user.user_id) return res.status(403).json({ successful: false, message: 'Access denied' });

    await prisma.rental_order.update({ where: { order_id }, data: { ispaid: true } });
    const io = req.app.get('io');
    io?.to(`user-${order.buyer_id}`).emit(`rental-paid-${order_id}`, { message: 'Rental order payment confirmed' });
    return res.json({ successful: true, message: 'Rental order marked as paid' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

export default router;
