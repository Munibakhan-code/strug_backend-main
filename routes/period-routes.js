import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { isAdmin } from '../middleware/require-admin.js';

const router = express.Router();

// Period rows are sensitive health data. Every route is scoped to the flo_user profiles the
// caller owns (flo_user.user_id === caller) — an admin may see all. The embedded flo_user.user
// is narrowed so we never serialize plaintext email/phone/KYC.
const SAFE_FLO_USER_INCLUDE = { include: { user: { select: { user_id: true, name: true } } } };

// flo_user_ids belonging to the caller. Empty array => the caller owns no cycle profiles.
async function myFloUserIds(req) {
    const rows = await prisma.flo_user.findMany({
        where: { user_id: req.user.user_id },
        select: { flo_user_id: true },
    });
    return rows.map((r) => r.flo_user_id);
}

/* GET ALL PERIODS (own only; admin: all) */
router.get('/', authenticateToken, async (req, res) => {
    try {
        const where = isAdmin(req) ? {} : { flo_user_id: { in: await myFloUserIds(req) } };
        const periods = await prisma.period.findMany({
            where,
            orderBy: { period_id: 'desc' },
            include: { flo_user: SAFE_FLO_USER_INCLUDE },
        });
        res.json(periods);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch periods' });
    }
});

/* GET PERIOD BY ID (owner or admin) */
router.get('/:period_id', authenticateToken, async (req, res) => {
    try {
        const period_id = Number(req.params.period_id);
        if (Number.isNaN(period_id)) return res.status(400).json({ error: 'period_id must be a number' });

        const period = await prisma.period.findUnique({
            where: { period_id },
            include: { flo_user: SAFE_FLO_USER_INCLUDE },
        });

        if (!period) return res.status(404).json({ error: 'Period not found' });
        if (!isAdmin(req) && !(await myFloUserIds(req)).includes(period.flo_user_id)) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        res.json(period);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch period' });
    }
});

/* GET PERIODS BY FLO USER ID (must own that flo_user, or admin) */
router.get('/flo-user/:flo_user_id', authenticateToken, async (req, res) => {
    try {
        const flo_user_id = Number(req.params.flo_user_id);
        if (Number.isNaN(flo_user_id)) return res.status(400).json({ error: 'flo_user_id must be a number' });
        if (!isAdmin(req) && !(await myFloUserIds(req)).includes(flo_user_id)) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        const periods = await prisma.period.findMany({
            where: { flo_user_id },
            orderBy: { start_date: 'desc' },
            include: { flo_user: SAFE_FLO_USER_INCLUDE },
        });
        res.json(periods);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch periods for flo user' });
    }
});

/* CREATE PERIOD (only for a flo_user the caller owns) */
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { flo_user_id, start_date, end_date } = req.body;
        const targetFloId = Number(flo_user_id);
        if (Number.isNaN(targetFloId)) return res.status(400).json({ error: 'flo_user_id is required' });
        if (!isAdmin(req) && !(await myFloUserIds(req)).includes(targetFloId)) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        const period = await prisma.period.create({
            data: {
                flo_user_id: targetFloId,
                start_date: new Date(start_date),
                end_date: end_date ? new Date(end_date) : null,
                created_at: new Date(),
            },
            include: { flo_user: SAFE_FLO_USER_INCLUDE },
        });

        res.status(201).json(period);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create period' });
    }
});

/* UPDATE PERIOD (owner or admin; cannot reassign to an unowned flo_user) */
router.put('/:period_id', authenticateToken, async (req, res) => {
    try {
        const period_id = Number(req.params.period_id);
        if (Number.isNaN(period_id)) return res.status(400).json({ error: 'period_id must be a number' });

        const { flo_user_id, start_date, end_date } = req.body;

        const existing = await prisma.period.findUnique({ where: { period_id } });
        if (!existing) return res.status(404).json({ error: 'Period not found' });

        const ownedIds = isAdmin(req) ? null : await myFloUserIds(req);
        if (ownedIds && !ownedIds.includes(existing.flo_user_id)) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        // Reassigning to a different flo_user requires owning the target too.
        if (flo_user_id != null && Number(flo_user_id) !== existing.flo_user_id
            && ownedIds && !ownedIds.includes(Number(flo_user_id))) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        const updated = await prisma.period.update({
            where: { period_id },
            data: {
                flo_user_id: flo_user_id != null ? Number(flo_user_id) : existing.flo_user_id,
                start_date: start_date ? new Date(start_date) : existing.start_date,
                end_date: end_date ? new Date(end_date) : existing.end_date,
            },
            include: { flo_user: SAFE_FLO_USER_INCLUDE },
        });
        res.json(updated);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update period' });
    }
});

/* DELETE PERIOD (owner or admin) */
router.delete('/:period_id', authenticateToken, async (req, res) => {
    try {
        const period_id = Number(req.params.period_id);
        if (Number.isNaN(period_id)) return res.status(400).json({ error: 'period_id must be a number' });

        const existing = await prisma.period.findUnique({ where: { period_id } });
        if (!existing) return res.status(404).json({ error: 'Period not found' });
        if (!isAdmin(req) && !(await myFloUserIds(req)).includes(existing.flo_user_id)) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        await prisma.period.delete({ where: { period_id } });
        res.json({ message: 'Period deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete period' });
    }
});

export default router;
