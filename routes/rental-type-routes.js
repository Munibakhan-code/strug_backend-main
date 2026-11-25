import express from 'express';
import { authenticateToken } from '../middleware/authentication.js';
import prisma from '../utils/prisma-client.js';

const router = express.Router();

/* GET ALL RENTAL TYPES */
router.get('/', async (_req, res) => {
    try {
        const types = await prisma.rental_type.findMany({
            orderBy: { rental_type_id: 'asc' },
        });
        res.json(types);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch rental types' });
    }
});

/* GET RENTAL TYPE BY ID */
router.get('/:rental_type_id', async (req, res) => {
    try {
        const rental_type_id = Number(req.params.rental_type_id);
        if (Number.isNaN(rental_type_id)) return res.status(400).json({ error: 'rental_type_id must be a number' });

        const type = await prisma.rental_type.findUnique({
            where: { rental_type_id },
        });

        if (!type) return res.status(404).json({ error: 'Rental type not found' });
        res.json(type);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch rental type' });
    }
});

/* CREATE RENTAL TYPE */
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { rental_type_name } = req.body;

        const newType = await prisma.rental_type.create({
            data: {
                rental_type_name,
            },
        });

        res.status(201).json(newType);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create rental type' });
    }
});

/* UPDATE RENTAL TYPE */
router.put('/:rental_type_id', authenticateToken, async (req, res) => {
    try {
        const rental_type_id = Number(req.params.rental_type_id);
        if (Number.isNaN(rental_type_id)) return res.status(400).json({ error: 'rental_type_id must be a number' });

        const { rental_type_name } = req.body;

        const existing = await prisma.rental_type.findUnique({ where: { rental_type_id } });
        if (!existing) return res.status(404).json({ error: 'Rental type not found' });

        const updated = await prisma.rental_type.update({
            where: { rental_type_id },
            data: {
                rental_type_name: rental_type_name ?? existing.rental_type_name,
            },
        });
        res.json(updated);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update rental type' });
    }
});

/* DELETE RENTAL TYPE */
router.delete('/:rental_type_id', authenticateToken, async (req, res) => {
    try {
        const rental_type_id = Number(req.params.rental_type_id);
        if (Number.isNaN(rental_type_id)) return res.status(400).json({ error: 'rental_type_id must be a number' });

        await prisma.rental_type.delete({ where: { rental_type_id } });
        res.json({ message: 'Rental type deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete rental type' });
    }
});

export default router;
