import express from 'express';
import { authenticateToken } from '../middleware/authentication.js';
import prisma from '../utils/prisma-client.js';

const router = express.Router();

/* GET ALL PLACE PICS */
router.get('/', async (_req, res) => {
    try {
        const pics = await prisma.place_pics.findMany({
            orderBy: { place_pics_id: 'desc' },
            include: {
                place: true,
                event_type: true
            },
        });
        res.json(pics);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch place pics' });
    }
});

/* GET PICS BY PLACE ID */
router.get('/place/:place_id', async (req, res) => {
    try {
        const place_id = Number(req.params.place_id);
        if (Number.isNaN(place_id)) return res.status(400).json({ error: 'place_id must be a number' });

        const pics = await prisma.place_pics.findMany({
            where: { place_id },
        });
        res.json(pics);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch pics for place' });
    }
});

/* ADD PLACE PIC */
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { place_id, place_pic_url, event_type_id } = req.body;

        const pic = await prisma.place_pics.create({
            data: {
                place_id,
                place_pic_url,
                event_type_id,
            },
            include: {
                place: true,
                event_type: true
            },
        });

        res.status(201).json(pic);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to add place pic' });
    }
});

/* UPDATE PLACE PIC */
router.put('/:place_pics_id', authenticateToken, async (req, res) => {
    try {
        const place_pics_id = Number(req.params.place_pics_id);
        if (Number.isNaN(place_pics_id)) return res.status(400).json({ error: 'place_pics_id must be a number' });

        const { place_id, place_pic_url, event_type_id } = req.body;

        const existing = await prisma.place_pics.findUnique({ where: { place_pics_id } });
        if (!existing) return res.status(404).json({ error: 'Place pic not found' });

        const updated = await prisma.place_pics.update({
            where: { place_pics_id },
            data: {
                place_id: place_id ?? existing.place_id,
                place_pic_url: place_pic_url ?? existing.place_pic_url,
                event_type_id: event_type_id ?? existing.event_type_id,
            },
            include: {
                place: true,
                event_type: true
            },
        });
        res.json(updated);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update place pic' });
    }
});

/* DELETE PLACE PIC */
router.delete('/:place_pics_id', authenticateToken, async (req, res) => {
    try {
        const place_pics_id = Number(req.params.place_pics_id);
        if (Number.isNaN(place_pics_id)) return res.status(400).json({ error: 'place_pics_id must be a number' });

        await prisma.place_pics.delete({ where: { place_pics_id } });
        res.json({ message: 'Place pic deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete place pic' });
    }
});

export default router;
