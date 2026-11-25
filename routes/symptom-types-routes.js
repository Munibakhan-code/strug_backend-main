import express from 'express';
import { authenticateToken } from '../middleware/authentication.js';
import prisma from '../utils/prisma-client.js';

const router = express.Router();

/* GET ALL SYMPTOM TYPES */
router.get('/', async (_req, res) => {
    try {
        const types = await prisma.symptom_types.findMany({
            orderBy: { symptom_type_id: 'asc' },
        });
        res.json(types);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch symptom types' });
    }
});

/* GET SYMPTOM TYPE BY ID */
router.get('/:symptom_type_id', async (req, res) => {
    try {
        const symptom_type_id = Number(req.params.symptom_type_id);
        if (Number.isNaN(symptom_type_id)) return res.status(400).json({ error: 'symptom_type_id must be a number' });

        const type = await prisma.symptom_types.findUnique({
            where: { symptom_type_id },
        });

        if (!type) return res.status(404).json({ error: 'Symptom type not found' });
        res.json(type);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch symptom type' });
    }
});

/* CREATE SYMPTOM TYPE */
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { symptom_name } = req.body;

        const newType = await prisma.symptom_types.create({
            data: {
                symptom_name,
            },
        });

        res.status(201).json(newType);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create symptom type' });
    }
});

/* UPDATE SYMPTOM TYPE */
router.put('/:symptom_type_id', authenticateToken, async (req, res) => {
    try {
        const symptom_type_id = Number(req.params.symptom_type_id);
        if (Number.isNaN(symptom_type_id)) return res.status(400).json({ error: 'symptom_type_id must be a number' });

        const { symptom_name } = req.body;

        const existing = await prisma.symptom_types.findUnique({ where: { symptom_type_id } });
        if (!existing) return res.status(404).json({ error: 'Symptom type not found' });

        const updated = await prisma.symptom_types.update({
            where: { symptom_type_id },
            data: {
                symptom_name: symptom_name ?? existing.symptom_name,
            },
        });
        res.json(updated);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update symptom type' });
    }
});

/* DELETE SYMPTOM TYPE */
router.delete('/:symptom_type_id', authenticateToken, async (req, res) => {
    try {
        const symptom_type_id = Number(req.params.symptom_type_id);
        if (Number.isNaN(symptom_type_id)) return res.status(400).json({ error: 'symptom_type_id must be a number' });

        await prisma.symptom_types.delete({ where: { symptom_type_id } });
        res.json({ message: 'Symptom type deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete symptom type' });
    }
});

export default router;
