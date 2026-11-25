import express from 'express';
import { authenticateToken } from '../middleware/authentication.js';
import prisma from '../utils/prisma-client.js';

const router = express.Router();

/* GET ALL PLATFORM TYPES */
router.get('/', async (_req, res) => {
    try {
        const types = await prisma.platform_type.findMany({
            orderBy: { platform_type_id: 'asc' },
        });
        res.json(types);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch platform types' });
    }
});

/* GET PLATFORM TYPE BY ID */
router.get('/:platform_type_id', async (req, res) => {
    try {
        const platform_type_id = Number(req.params.platform_type_id);
        if (Number.isNaN(platform_type_id)) return res.status(400).json({ error: 'platform_type_id must be a number' });

        const type = await prisma.platform_type.findUnique({
            where: { platform_type_id },
        });

        if (!type) return res.status(404).json({ error: 'Platform type not found' });
        res.json(type);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch platform type' });
    }
});

/* CREATE PLATFORM TYPE */
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { platform_type } = req.body;

        const newType = await prisma.platform_type.create({
            data: {
                platform_type,
            },
        });

        res.status(201).json(newType);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create platform type' });
    }
});

/* UPDATE PLATFORM TYPE */
router.put('/:platform_type_id', authenticateToken, async (req, res) => {
    try {
        const platform_type_id = Number(req.params.platform_type_id);
        if (Number.isNaN(platform_type_id)) return res.status(400).json({ error: 'platform_type_id must be a number' });

        const { platform_type } = req.body;

        const existing = await prisma.platform_type.findUnique({ where: { platform_type_id } });
        if (!existing) return res.status(404).json({ error: 'Platform type not found' });

        const updated = await prisma.platform_type.update({
            where: { platform_type_id },
            data: {
                platform_type: platform_type ?? existing.platform_type,
            },
        });
        res.json(updated);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update platform type' });
    }
});

/* DELETE PLATFORM TYPE */
router.delete('/:platform_type_id', authenticateToken, async (req, res) => {
    try {
        const platform_type_id = Number(req.params.platform_type_id);
        if (Number.isNaN(platform_type_id)) return res.status(400).json({ error: 'platform_type_id must be a number' });

        await prisma.platform_type.delete({ where: { platform_type_id } });
        res.json({ message: 'Platform type deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete platform type' });
    }
});

export default router;
