import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { validateProductRatingBody } from '../utils/shop-rating.js';

const router = express.Router();

/* GET ALL RATINGS — auth required (admin-style dump) */
router.get('/', authenticateToken, async (_req, res) => {
    try {
        const ratings = await prisma.product_ratings.findMany({
            orderBy: { rating_id: 'desc' },
            include: {
                product_order: true,
                product_type: true,
                user_product_ratings_buyer_idTouser: true,
                user_product_ratings_seller_idTouser: true
            },
        });
        res.json(ratings);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch product ratings' });
    }
});

/* GET RATINGS BY SELLER ID — public for storefront reviews */
router.get('/seller/:seller_id', async (req, res) => {
    try {
        const seller_id = Number(req.params.seller_id);
        if (Number.isNaN(seller_id)) return res.status(400).json({ error: 'seller_id must be a number' });

        const ratings = await prisma.product_ratings.findMany({
            where: { seller_id },
            orderBy: { rating_id: 'desc' },
            include: {
                product_order: true,
                user_product_ratings_buyer_idTouser: {
                    select: { user_id: true, name: true, username: true },
                },
            },
        });
        res.json(ratings);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch seller ratings' });
    }
});

/* CREATE RATING — buyer_id from JWT */
router.post('/', authenticateToken, async (req, res) => {
    try {
        const parsed = validateProductRatingBody({
            ...req.body,
            buyer_id: req.user.user_id,
        });
        if (!parsed.ok) {
            return res.status(400).json({ error: parsed.errors.join('; ') });
        }

        const newRating = await prisma.product_ratings.create({
            data: parsed.data,
            include: {
                product_order: true,
                product_type: true,
            },
        });

        res.status(201).json(newRating);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create product rating' });
    }
});

/* UPDATE RATING — owner only */
router.put('/:rating_id', authenticateToken, async (req, res) => {
    try {
        const rating_id = Number(req.params.rating_id);
        if (Number.isNaN(rating_id)) return res.status(400).json({ error: 'rating_id must be a number' });

        const existing = await prisma.product_ratings.findUnique({ where: { rating_id } });
        if (!existing) return res.status(404).json({ error: 'Product rating not found' });
        if (existing.buyer_id !== req.user.user_id) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const { rating, feedback, product_type_id } = req.body;

        const updated = await prisma.product_ratings.update({
            where: { rating_id },
            data: {
                rating: rating ?? existing.rating,
                feedback: feedback ?? existing.feedback,
                product_type_id: product_type_id ?? existing.product_type_id,
            },
        });
        res.json(updated);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update product rating' });
    }
});

/* DELETE RATING — owner only */
router.delete('/:rating_id', authenticateToken, async (req, res) => {
    try {
        const rating_id = Number(req.params.rating_id);
        if (Number.isNaN(rating_id)) return res.status(400).json({ error: 'rating_id must be a number' });

        const existing = await prisma.product_ratings.findUnique({ where: { rating_id } });
        if (!existing) return res.status(404).json({ error: 'Product rating not found' });
        if (existing.buyer_id !== req.user.user_id) {
            return res.status(403).json({ error: 'Access denied' });
        }

        await prisma.product_ratings.delete({ where: { rating_id } });
        res.json({ message: 'Product rating deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete product rating' });
    }
});

export default router;
