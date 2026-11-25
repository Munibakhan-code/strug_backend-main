import express from 'express';
import { authenticateToken } from '../middleware/authentication.js';
import prisma from '../utils/prisma-client.js';

const router = express.Router();

/* GET ALL VARIATIONS */
router.get('/', async (_req, res) => {
    try {
        const variations = await prisma.product_variation.findMany({
            orderBy: { variation_id: 'desc' },
            include: {
                product_listing: true,
                product_type: true
            },
        });
        res.json(variations);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch product variations' });
    }
});

/* GET VARIATION BY ID */
router.get('/:variation_id', async (req, res) => {
    try {
        const variation_id = Number(req.params.variation_id);
        if (Number.isNaN(variation_id)) return res.status(400).json({ error: 'variation_id must be a number' });

        const variation = await prisma.product_variation.findUnique({
            where: { variation_id },
            include: {
                product_listing: true,
                product_type: true
            },
        });

        if (!variation) return res.status(404).json({ error: 'Variation not found' });
        res.json(variation);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch product variation' });
    }
});

/* GET VARIATIONS BY LISTING ID */
router.get('/listing/:listing_id', async (req, res) => {
    try {
        const listing_id = Number(req.params.listing_id);
        if (Number.isNaN(listing_id)) return res.status(400).json({ error: 'listing_id must be a number' });

        const variations = await prisma.product_variation.findMany({
            where: { listing_id },
            include: {
                product_listing: true,
                product_type: true
            },
        });
        res.json(variations);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch listing variations' });
    }
});

/* CREATE VARIATION */
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { listing_id, price, description, vname, image_url, product_type_id } = req.body;

        const variation = await prisma.product_variation.create({
            data: {
                listing_id,
                price,
                description,
                vname,
                image_url,
                product_type_id,
            },
            include: {
                product_listing: true,
                product_type: true
            },
        });

        res.status(201).json(variation);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create product variation' });
    }
});

/* UPDATE VARIATION */
router.put('/:variation_id', authenticateToken, async (req, res) => {
    try {
        const variation_id = Number(req.params.variation_id);
        if (Number.isNaN(variation_id)) return res.status(400).json({ error: 'variation_id must be a number' });

        const { listing_id, price, description, vname, image_url, product_type_id } = req.body;

        const existing = await prisma.product_variation.findUnique({ where: { variation_id } });
        if (!existing) return res.status(404).json({ error: 'Variation not found' });

        const updated = await prisma.product_variation.update({
            where: { variation_id },
            data: {
                listing_id: listing_id ?? existing.listing_id,
                price: price ?? existing.price,
                description: description ?? existing.description,
                vname: vname ?? existing.vname,
                image_url: image_url ?? existing.image_url,
                product_type_id: product_type_id ?? existing.product_type_id,
            },
            include: {
                product_listing: true,
                product_type: true
            },
        });
        res.json(updated);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update product variation' });
    }
});

/* DELETE VARIATION */
router.delete('/:variation_id', authenticateToken, async (req, res) => {
    try {
        const variation_id = Number(req.params.variation_id);
        if (Number.isNaN(variation_id)) return res.status(400).json({ error: 'variation_id must be a number' });

        await prisma.product_variation.delete({ where: { variation_id } });
        res.json({ message: 'Variation deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete product variation' });
    }
});

export default router;
