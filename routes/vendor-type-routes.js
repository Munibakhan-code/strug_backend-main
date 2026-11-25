import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken, requireAdmin } from '../middleware/authentication.js';

const router = express.Router();

/* GET ALL VENDOR TYPES (public — used by the storefront feeds + provider registration) */
router.get('/', async (_req, res) => {
    try {
        const types = await prisma.vendor_type.findMany({
            orderBy: { vendor_type_id: 'asc' },
        });
        res.json(types);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch vendor types' });
    }
});

/* GET VENDOR TYPE BY ID (public) */
router.get('/:vendor_type_id', async (req, res) => {
    try {
        const vendor_type_id = Number(req.params.vendor_type_id);
        if (Number.isNaN(vendor_type_id)) return res.status(400).json({ error: 'vendor_type_id must be a number' });

        const type = await prisma.vendor_type.findUnique({
            where: { vendor_type_id },
        });

        if (!type) return res.status(404).json({ error: 'Vendor type not found' });
        res.json(type);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch vendor type' });
    }
});

/* CREATE VENDOR TYPE — auth required + idempotent by name.
 * This endpoint was previously unauthenticated and non-deduping, which let the prod
 * vendor_type table accumulate 180+ duplicate "Grocery" rows. Provider registration now
 * resolves a type by name (get-or-create), so we dedup here: if a type with the same
 * (case-insensitive) name already exists, return it instead of creating a duplicate. */
router.post('/', authenticateToken, async (req, res) => {
    try {
        const vendor_type = String(req.body?.vendor_type ?? '').trim();
        if (!vendor_type) return res.status(400).json({ error: 'vendor_type is required' });
        if (vendor_type.length > 100) return res.status(400).json({ error: 'vendor_type too long' });

        const existing = await prisma.vendor_type.findFirst({
            where: { vendor_type: { equals: vendor_type, mode: 'insensitive' } },
        });
        if (existing) return res.status(200).json(existing);

        const newType = await prisma.vendor_type.create({ data: { vendor_type } });
        res.status(201).json(newType);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create vendor type' });
    }
});

/* UPDATE VENDOR TYPE — admin only (taxonomy management) */
router.put('/:vendor_type_id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const vendor_type_id = Number(req.params.vendor_type_id);
        if (Number.isNaN(vendor_type_id)) return res.status(400).json({ error: 'vendor_type_id must be a number' });

        const { vendor_type } = req.body;

        const existing = await prisma.vendor_type.findUnique({ where: { vendor_type_id } });
        if (!existing) return res.status(404).json({ error: 'Vendor type not found' });

        const updated = await prisma.vendor_type.update({
            where: { vendor_type_id },
            data: {
                vendor_type: vendor_type ?? existing.vendor_type,
            },
        });
        res.json(updated);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update vendor type' });
    }
});

/* DELETE VENDOR TYPE — admin only */
router.delete('/:vendor_type_id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const vendor_type_id = Number(req.params.vendor_type_id);
        if (Number.isNaN(vendor_type_id)) return res.status(400).json({ error: 'vendor_type_id must be a number' });

        await prisma.vendor_type.delete({ where: { vendor_type_id } });
        res.json({ message: 'Vendor type deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete vendor type' });
    }
});

export default router;
