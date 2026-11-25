import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { isAdmin } from '../middleware/require-admin.js';

const router = express.Router();

// Flo profiles are reproductive-health data. Mirror period/symptom-log: auth + owner scope
// (admin may see all). Never trust body user_id on create. Narrow embedded user.
const SAFE_USER = { select: { user_id: true, name: true } };
const FLO_INCLUDE = {
  user: SAFE_USER,
  cycle_prediction: true,
  period: true,
  symptom_log: true,
};

function parseId(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : NaN;
}

function ownsFlo(flo, req) {
  return flo && flo.user_id === req.user.user_id;
}

/* GET own flo profiles (admin: all). No public list-all. */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const where = isAdmin(req) ? {} : { user_id: req.user.user_id };
    const floUsers = await prisma.flo_user.findMany({
      where,
      orderBy: { flo_user_id: 'desc' },
      include: FLO_INCLUDE,
      take: 100,
    });
    res.json(floUsers);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch flo users' });
  }
});

/* GET FLO USER BY ID (owner or admin) */
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const flo_user_id = parseId(req.params.id);
    if (Number.isNaN(flo_user_id)) return res.status(400).json({ error: 'id must be a number' });

    const floUser = await prisma.flo_user.findUnique({
      where: { flo_user_id },
      include: FLO_INCLUDE,
    });

    if (!floUser) return res.status(404).json({ error: 'Flo user not found' });
    if (!isAdmin(req) && !ownsFlo(floUser, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    res.json(floUser);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch flo user' });
  }
});

/* CREATE: user_id from JWT only; one flo profile per account (#1293) */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { avg_cycle_length, avg_period_length } = req.body;

    const existing = await prisma.flo_user.findUnique({
      where: { user_id: req.user.user_id },
      include: FLO_INCLUDE,
    });
    if (existing) {
      return res.status(409).json({ error: 'Flo profile already exists for this account' });
    }

    const floUser = await prisma.flo_user.create({
      data: {
        user_id: req.user.user_id,
        avg_cycle_length: avg_cycle_length ? parseInt(avg_cycle_length, 10) : 28,
        avg_period_length: avg_period_length ? parseInt(avg_period_length, 10) : 5,
      },
      include: FLO_INCLUDE,
    });

    res.status(201).json(floUser);
  } catch (err) {
    if (err?.code === 'P2002') {
      return res.status(409).json({ error: 'Flo profile already exists for this account' });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to create flo user' });
  }
});

/* UPDATE (owner or admin) */
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const flo_user_id = parseId(req.params.id);
    if (Number.isNaN(flo_user_id)) return res.status(400).json({ error: 'id must be a number' });

    const existing = await prisma.flo_user.findUnique({ where: { flo_user_id } });
    if (!existing) return res.status(404).json({ error: 'Flo user not found' });
    if (!isAdmin(req) && !ownsFlo(existing, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { avg_cycle_length, avg_period_length } = req.body;
    const floUser = await prisma.flo_user.update({
      where: { flo_user_id },
      data: {
        avg_cycle_length: avg_cycle_length != null ? parseInt(avg_cycle_length, 10) : undefined,
        avg_period_length: avg_period_length != null ? parseInt(avg_period_length, 10) : undefined,
      },
      include: FLO_INCLUDE,
    });

    res.json(floUser);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update flo user' });
  }
});

/* DELETE (owner or admin) */
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const flo_user_id = parseId(req.params.id);
    if (Number.isNaN(flo_user_id)) return res.status(400).json({ error: 'id must be a number' });

    const existing = await prisma.flo_user.findUnique({ where: { flo_user_id } });
    if (!existing) return res.status(404).json({ error: 'Flo user not found' });
    if (!isAdmin(req) && !ownsFlo(existing, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await prisma.flo_user.delete({ where: { flo_user_id } });
    res.json({ message: 'Flo user deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete flo user' });
  }
});

export default router;
