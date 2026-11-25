import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/* GET ALL PLACE ORDERS */
router.get('/', async (_req, res) => {
    try {
        const orders = await prisma.place_orders.findMany({
            orderBy: { place_order_id: 'desc' },
            include: {
                place: true,
                user: true,
                event_type: true
            },
        });
        res.json(orders);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch place orders' });
    }
});

/* GET PLACE ORDER BY ID */
router.get('/:place_order_id', async (req, res) => {
    try {
        const place_order_id = Number(req.params.place_order_id);
        if (Number.isNaN(place_order_id)) return res.status(400).json({ error: 'place_order_id must be a number' });

        const order = await prisma.place_orders.findUnique({
            where: { place_order_id },
            include: {
                place: true,
                user: true,
                event_type: true
            },
        });

        if (!order) return res.status(404).json({ error: 'Place order not found' });
        res.json(order);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch place order' });
    }
});

/* GET ORDERS BY USER ID */
router.get('/user/:user_id', async (req, res) => {
    try {
        const user_id = Number(req.params.user_id);
        if (Number.isNaN(user_id)) return res.status(400).json({ error: 'user_id must be a number' });

        const orders = await prisma.place_orders.findMany({
            where: { user_id },
            include: {
                place: true,
                event_type: true
            },
        });
        res.json(orders);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch user place orders' });
    }
});

/* CREATE PLACE ORDER */
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { place_id, no_of_hours, price, is_available, reserve_date, time_from, time_to, note, event_type_id } = req.body;

        const place = place_id ? await prisma.place.findUnique({ where: { place_id: Number(place_id) }, select: { instant_booking: true } }) : null;
        const autoConfirm = place?.instant_booking === true;

        const order = await prisma.place_orders.create({
            data: {
                place_id,
                user_id: req.user.user_id, // C2: always from JWT, never body
                no_of_hours,
                price,
                is_available,
                reserve_date: new Date(reserve_date),
                time_from,
                time_to,
                note,
                event_type_id,
                ...(autoConfirm && { status: 'confirmed' }),
            },
            include: {
                place: true,
                user: true,
                event_type: true
            },
        });

        res.status(201).json(order);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create place order' });
    }
});

/* UPDATE PLACE ORDER */
router.put('/:place_order_id', authenticateToken, async (req, res) => {
    try {
        const place_order_id = Number(req.params.place_order_id);
        if (Number.isNaN(place_order_id)) return res.status(400).json({ error: 'place_order_id must be a number' });

        // user_id is intentionally NOT read from the body — a booking can never be reassigned to
        // another user via update (that was a booking-hijack vector).
        const { place_id, no_of_hours, price, is_available, reserve_date, time_from, time_to, note, event_type_id } = req.body;

        const existing = await prisma.place_orders.findUnique({ where: { place_order_id }, include: { place: true } });
        if (!existing) return res.status(404).json({ error: 'Place order not found' });

        // Only the booking's owner or the venue owner may edit it.
        const isBooker = existing.user_id === req.user.user_id;
        const isVenueOwner = !!existing.place?.user_id && existing.place.user_id === req.user.user_id;
        if (!isBooker && !isVenueOwner) return res.status(403).json({ error: 'Forbidden' });

        const updated = await prisma.place_orders.update({
            where: { place_order_id },
            data: {
                place_id: place_id ?? existing.place_id,
                no_of_hours: no_of_hours ?? existing.no_of_hours,
                price: price ?? existing.price,
                is_available: is_available ?? existing.is_available,
                reserve_date: reserve_date ? new Date(reserve_date) : existing.reserve_date,
                time_from: time_from ?? existing.time_from,
                time_to: time_to ?? existing.time_to,
                note: note ?? existing.note,
                event_type_id: event_type_id ?? existing.event_type_id,
            },
            include: {
                place: true,
                user: true,
                event_type: true
            },
        });
        res.json(updated);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update place order' });
    }
});

/* DELETE PLACE ORDER */
router.delete('/:place_order_id', authenticateToken, async (req, res) => {
    try {
        const place_order_id = Number(req.params.place_order_id);
        if (Number.isNaN(place_order_id)) return res.status(400).json({ error: 'place_order_id must be a number' });

        const existing = await prisma.place_orders.findUnique({ where: { place_order_id }, include: { place: true } });
        if (!existing) return res.status(404).json({ error: 'Place order not found' });

        // Only the booking's owner or the venue owner may delete it.
        const isBooker = existing.user_id === req.user.user_id;
        const isVenueOwner = !!existing.place?.user_id && existing.place.user_id === req.user.user_id;
        if (!isBooker && !isVenueOwner) return res.status(403).json({ error: 'Forbidden' });

        await prisma.place_orders.delete({ where: { place_order_id } });
        res.json({ message: 'Place order deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete place order' });
    }
});

/* PUT /:place_order_id/accept — venue/event provider accepts booking */
router.put('/:place_order_id/accept', authenticateToken, async (req, res) => {
    try {
        const place_order_id = Number(req.params.place_order_id);
        if (Number.isNaN(place_order_id)) return res.status(400).json({ successful: false, message: 'place_order_id must be a number' });

        const order = await prisma.place_orders.findUnique({ where: { place_order_id }, include: { place: true } });
        if (!order) return res.status(404).json({ successful: false, message: 'Place order not found' });
        if (order.status !== 'pending') return res.status(400).json({ successful: false, message: 'Order no longer pending' });

        // S5: missing owner treated as forbidden, not a bypass
        if (!order.place?.user_id || order.place.user_id !== req.user.user_id) {
            return res.status(403).json({ successful: false, message: 'Forbidden' });
        }

        await prisma.place_orders.update({ where: { place_order_id }, data: { status: 'accepted' } });
        const io = req.app.get('io');
        io?.to(`user-${order.user_id}`).emit(`place-order-accepted-${place_order_id}`, { message: 'Place order accepted' });
        return res.json({ successful: true, message: 'Place order accepted' });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

/* PUT /:place_order_id/decline — venue/event provider declines booking */
router.put('/:place_order_id/decline', authenticateToken, async (req, res) => {
    try {
        const place_order_id = Number(req.params.place_order_id);
        if (Number.isNaN(place_order_id)) return res.status(400).json({ successful: false, message: 'place_order_id must be a number' });

        const order = await prisma.place_orders.findUnique({ where: { place_order_id }, include: { place: true } });
        if (!order) return res.status(404).json({ successful: false, message: 'Place order not found' });
        if (order.status !== 'pending') return res.status(400).json({ successful: false, message: 'Order no longer pending' });

        // S5: missing owner treated as forbidden, not a bypass
        if (!order.place?.user_id || order.place.user_id !== req.user.user_id) {
            return res.status(403).json({ successful: false, message: 'Forbidden' });
        }

        await prisma.place_orders.update({ where: { place_order_id }, data: { status: 'declined' } });
        const io = req.app.get('io');
        io?.to(`user-${order.user_id}`).emit(`place-order-declined-${place_order_id}`, { message: 'Place order declined' });
        return res.json({ successful: true, message: 'Place order declined' });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

/* PATCH /:place_order_id/complete — event/booking completed */
router.patch('/:place_order_id/complete', authenticateToken, async (req, res) => {
    try {
        const place_order_id = Number(req.params.place_order_id);
        if (Number.isNaN(place_order_id)) return res.status(400).json({ successful: false, message: 'place_order_id must be a number' });

        const order = await prisma.place_orders.findUnique({ where: { place_order_id }, include: { place: true } });
        if (!order) return res.status(404).json({ successful: false, message: 'Place order not found' });
        if (order.status !== 'accepted') return res.status(400).json({ successful: false, message: 'Order must be accepted before completing' });

        // C3: only the venue owner or the buyer can mark complete
        const isOwner = order.place?.user_id && order.place.user_id === req.user.user_id;
        const isBuyer = order.user_id === req.user.user_id;
        if (!isOwner && !isBuyer) {
            return res.status(403).json({ successful: false, message: 'Forbidden' });
        }

        await prisma.place_orders.update({ where: { place_order_id }, data: { status: 'completed' } });
        const io = req.app.get('io');
        io?.to(`user-${order.user_id}`).emit(`place-order-completed-${place_order_id}`, { message: 'Place order completed' });
        return res.json({ successful: true, message: 'Place order completed' });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ successful: false, message: 'Internal server error' });
    }
});

export default router;
