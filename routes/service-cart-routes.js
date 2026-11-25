import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { isAdmin } from '../middleware/require-admin.js';

const router = express.Router();

/* GET ALL SERVICE CART ITEMS */
router.get('/', authenticateToken, async (_req, res) => {
    try {
        const cartItems = await prisma.service_cart.findMany({
            orderBy: { cart_id: 'desc' },
            include: {
                user: true,
                user_service_provider: true,
                service_type: true
            },
        });
        res.json(cartItems);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch service cart items' });
    }
});

/* GET CART ITEMS BY BUYER ID */
router.get('/buyer/:buyer_id', authenticateToken, async (req, res) => {
    try {
        const buyer_id = Number(req.params.buyer_id);
        if (Number.isNaN(buyer_id)) return res.status(400).json({ error: 'buyer_id must be a number' });

        const cartItems = await prisma.service_cart.findMany({
            where: { buyer_id },
            include: {
                user_service_provider: true,
                service_type: true
            },
        });
        res.json(cartItems);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch service cart items for buyer' });
    }
});

/* ADD TO CART */
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { provider_id, buyer_id, qty, total, service_type_id } = req.body;

        const cartItem = await prisma.service_cart.create({
            data: {
                provider_id,
                buyer_id,
                qty,
                total,
                service_type_id,
            },
            include: {
                user: true,
                user_service_provider: true,
                service_type: true
            },
        });

        res.status(201).json(cartItem);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to add item to service cart' });
    }
});

/* UPDATE CART ITEM — auth + ownership. Was unauthenticated: anyone could mutate any
   service_cart row by id (an IDOR), rewriting `total`/`buyer_id`, and the response even
   included the buyer's user record. Owner is never taken from the body. */
router.put('/:cart_id', authenticateToken, async (req, res) => {
    try {
        const cart_id = Number(req.params.cart_id);
        if (Number.isNaN(cart_id)) return res.status(400).json({ error: 'cart_id must be a number' });

        const { provider_id, qty, total, service_type_id } = req.body;

        const existing = await prisma.service_cart.findUnique({ where: { cart_id } });
        if (!existing) return res.status(404).json({ error: 'Cart item not found' });
        if (!isAdmin(req) && existing.buyer_id !== req.user.user_id) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        const updated = await prisma.service_cart.update({
            where: { cart_id },
            data: {
                provider_id: provider_id ?? existing.provider_id,
                qty: qty ?? existing.qty,
                total: total ?? existing.total,
                service_type_id: service_type_id ?? existing.service_type_id,
            },
            include: {
                user: true,
                user_service_provider: true,
                service_type: true
            },
        });
        res.json(updated);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update service cart item' });
    }
});

/* DELETE CART ITEM — auth + ownership (was an unauthenticated IDOR delete). */
router.delete('/:cart_id', authenticateToken, async (req, res) => {
    try {
        const cart_id = Number(req.params.cart_id);
        if (Number.isNaN(cart_id)) return res.status(400).json({ error: 'cart_id must be a number' });

        const existing = await prisma.service_cart.findUnique({ where: { cart_id } });
        if (!existing) return res.status(404).json({ error: 'Cart item not found' });
        if (!isAdmin(req) && existing.buyer_id !== req.user.user_id) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        await prisma.service_cart.delete({ where: { cart_id } });
        res.json({ message: 'Service cart item deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete service cart item' });
    }
});

export default router;
