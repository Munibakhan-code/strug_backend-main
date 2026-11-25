import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { isAdmin } from '../middleware/require-admin.js';

const router = express.Router();

/* GET ALL RENTAL CART ITEMS */
router.get('/', authenticateToken, async (_req, res) => {
    try {
        const cartItems = await prisma.rental_cart.findMany({
            orderBy: { cart_id: 'desc' },
            include: {
                user: true,
                rental_listing: {
                    include: {
                        rental_listing_pics: true
                    }
                },
                rental_type: true
            },
        });
        res.json(cartItems);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch rental cart items' });
    }
});

/* GET CART ITEMS BY BUYER ID */
router.get('/buyer/:buyer_id', authenticateToken, async (req, res) => {
    try {
        const buyer_id = Number(req.params.buyer_id);
        if (Number.isNaN(buyer_id)) return res.status(400).json({ error: 'buyer_id must be a number' });

        const cartItems = await prisma.rental_cart.findMany({
            where: { buyer_id },
            include: {
                rental_listing: {
                    include: {
                        rental_listing_pics: true
                    }
                },
                rental_type: true
            },
        });
        res.json(cartItems);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch rental cart items for buyer' });
    }
});

/* ADD TO CART */
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { rental_listing_id, buyer_id, qty, total, rental_type_id } = req.body;

        const cartItem = await prisma.rental_cart.create({
            data: {
                rental_listing_id,
                buyer_id,
                qty,
                total,
                rental_type_id,
            },
            include: {
                rental_listing: true,
                rental_type: true
            },
        });

        res.status(201).json(cartItem);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to add item to rental cart' });
    }
});

/* UPDATE CART ITEM — auth + ownership. Was unauthenticated: anyone could mutate any
   cart row by id (an IDOR), including rewriting `total`/`buyer_id`. The owner is never
   taken from the body; it stays whatever it already was. */
router.put('/:cart_id', authenticateToken, async (req, res) => {
    try {
        const cart_id = Number(req.params.cart_id);
        if (Number.isNaN(cart_id)) return res.status(400).json({ error: 'cart_id must be a number' });

        const { rental_listing_id, qty, total, rental_type_id } = req.body;

        const existing = await prisma.rental_cart.findUnique({ where: { cart_id } });
        if (!existing) return res.status(404).json({ error: 'Cart item not found' });
        if (!isAdmin(req) && existing.buyer_id !== req.user.user_id) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        const updated = await prisma.rental_cart.update({
            where: { cart_id },
            data: {
                rental_listing_id: rental_listing_id ?? existing.rental_listing_id,
                qty: qty ?? existing.qty,
                total: total ?? existing.total,
                rental_type_id: rental_type_id ?? existing.rental_type_id,
            },
            include: {
                rental_listing: true,
                rental_type: true
            },
        });
        res.json(updated);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update rental cart item' });
    }
});

/* DELETE CART ITEM — auth + ownership (was an unauthenticated IDOR delete). */
router.delete('/:cart_id', authenticateToken, async (req, res) => {
    try {
        const cart_id = Number(req.params.cart_id);
        if (Number.isNaN(cart_id)) return res.status(400).json({ error: 'cart_id must be a number' });

        const existing = await prisma.rental_cart.findUnique({ where: { cart_id } });
        if (!existing) return res.status(404).json({ error: 'Cart item not found' });
        if (!isAdmin(req) && existing.buyer_id !== req.user.user_id) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        await prisma.rental_cart.delete({ where: { cart_id } });
        res.json({ message: 'Cart item deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete rental cart item' });
    }
});

export default router;
