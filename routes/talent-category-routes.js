import express from 'express';
import { authenticateToken } from '../middleware/authentication.js';
import prisma from '../utils/prisma-client.js';

const router = express.Router();

/* GET ALL TALENT CATEGORIES */
router.get('/', async (_req, res) => {
    try {
        const categories = await prisma.talent_category.findMany({
            orderBy: { talent_category_id: 'asc' },
        });
        res.json(categories);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch talent categories' });
    }
});

/* GET TALENT CATEGORY BY ID */
router.get('/:talent_category_id', async (req, res) => {
    try {
        const talent_category_id = Number(req.params.talent_category_id);
        if (Number.isNaN(talent_category_id)) return res.status(400).json({ error: 'talent_category_id must be a number' });

        const category = await prisma.talent_category.findUnique({
            where: { talent_category_id },
        });

        if (!category) return res.status(404).json({ error: 'Talent category not found' });
        res.json(category);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch talent category' });
    }
});

/* CREATE TALENT CATEGORY */
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { talent_category_name } = req.body;

        const newCategory = await prisma.talent_category.create({
            data: {
                talent_category_name,
            },
        });

        res.status(201).json(newCategory);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create talent category' });
    }
});

/* UPDATE TALENT CATEGORY */
router.put('/:talent_category_id', authenticateToken, async (req, res) => {
    try {
        const talent_category_id = Number(req.params.talent_category_id);
        if (Number.isNaN(talent_category_id)) return res.status(400).json({ error: 'talent_category_id must be a number' });

        const { talent_category_name } = req.body;

        const existing = await prisma.talent_category.findUnique({ where: { talent_category_id } });
        if (!existing) return res.status(404).json({ error: 'Talent category not found' });

        const updated = await prisma.talent_category.update({
            where: { talent_category_id },
            data: {
                talent_category_name: talent_category_name ?? existing.talent_category_name,
            },
        });
        res.json(updated);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update talent category' });
    }
});

/* DELETE TALENT CATEGORY */
router.delete('/:talent_category_id', authenticateToken, async (req, res) => {
    try {
        const talent_category_id = Number(req.params.talent_category_id);
        if (Number.isNaN(talent_category_id)) return res.status(400).json({ error: 'talent_category_id must be a number' });

        await prisma.talent_category.delete({ where: { talent_category_id } });
        res.json({ message: 'Talent category deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete talent category' });
    }
});

export default router;
