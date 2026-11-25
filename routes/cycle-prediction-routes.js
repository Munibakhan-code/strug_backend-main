import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { isAdmin } from '../middleware/require-admin.js';

const router = express.Router();

// Cycle predictions are reproductive-health data. Scope like period/symptom (#1289).
const SAFE_FLO_USER_INCLUDE = { include: { user: { select: { user_id: true, name: true } } } };

async function myFloUserIds(req) {
  const rows = await prisma.flo_user.findMany({
    where: { user_id: req.user.user_id },
    select: { flo_user_id: true },
  });
  return rows.map((r) => r.flo_user_id);
}

/**
 * Get own cycle predictions (admin: all)
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const where = isAdmin(req) ? {} : { flo_user_id: { in: await myFloUserIds(req) } };
    const predictions = await prisma.cycle_prediction.findMany({
      where,
      orderBy: { prediction_id: 'desc' },
      include: { flo_user: SAFE_FLO_USER_INCLUDE },
      take: 200,
    });

    res.json(predictions);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch cycle predictions' });
  }
});

/**
 * Get a single cycle prediction (owner or admin)
 */
router.get('/:prediction_id', authenticateToken, async (req, res) => {
  try {
    const prediction_id = Number(req.params.prediction_id);
    if (Number.isNaN(prediction_id)) {
      return res.status(400).json({ error: 'prediction_id must be a number' });
    }

    const prediction = await prisma.cycle_prediction.findUnique({
      where: { prediction_id },
      include: { flo_user: SAFE_FLO_USER_INCLUDE },
    });

    if (!prediction) {
      return res.status(404).json({ error: 'Cycle prediction not found' });
    }
    if (!isAdmin(req) && !(await myFloUserIds(req)).includes(prediction.flo_user_id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    res.json(prediction);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch cycle prediction' });
  }
});

/**
 * Create cycle prediction (only for owned flo_user)
 */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const {
      flo_user_id,
      cycle_start_date,
      predicted_period_start,
      predicted_period_end,
      predicted_ovulation_date,
      fertile_window_start,
      fertile_window_end,
    } = req.body;

    const targetFloId = Number(flo_user_id);
    if (!Number.isInteger(targetFloId) || targetFloId <= 0 || !cycle_start_date) {
      return res.status(400).json({ error: 'flo_user_id and cycle_start_date are required' });
    }
    if (!isAdmin(req) && !(await myFloUserIds(req)).includes(targetFloId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const newPrediction = await prisma.cycle_prediction.create({
      data: {
        flo_user_id: targetFloId,
        cycle_start_date: new Date(cycle_start_date),
        predicted_period_start: predicted_period_start ? new Date(predicted_period_start) : null,
        predicted_period_end: predicted_period_end ? new Date(predicted_period_end) : null,
        predicted_ovulation_date: predicted_ovulation_date ? new Date(predicted_ovulation_date) : null,
        fertile_window_start: fertile_window_start ? new Date(fertile_window_start) : null,
        fertile_window_end: fertile_window_end ? new Date(fertile_window_end) : null,
      },
      include: { flo_user: SAFE_FLO_USER_INCLUDE },
    });

    // No unscoped io.emit: reproductive-health rows must not broadcast to every socket.

    res.status(201).json(newPrediction);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create cycle prediction' });
  }
});

/**
 * Update cycle prediction (owner or admin; cannot reassign to unowned flo_user)
 */
router.put('/:prediction_id', authenticateToken, async (req, res) => {
  try {
    const prediction_id = Number(req.params.prediction_id);
    if (Number.isNaN(prediction_id)) {
      return res.status(400).json({ error: 'prediction_id must be a number' });
    }

    const {
      flo_user_id,
      cycle_start_date,
      predicted_period_start,
      predicted_period_end,
      predicted_ovulation_date,
      fertile_window_start,
      fertile_window_end,
    } = req.body;

    const existing = await prisma.cycle_prediction.findUnique({
      where: { prediction_id },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Cycle prediction not found' });
    }

    const ownedIds = isAdmin(req) ? null : await myFloUserIds(req);
    if (ownedIds && !ownedIds.includes(existing.flo_user_id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (
      flo_user_id != null
      && Number(flo_user_id) !== existing.flo_user_id
      && ownedIds
      && !ownedIds.includes(Number(flo_user_id))
    ) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const updatedPrediction = await prisma.cycle_prediction.update({
      where: { prediction_id },
      data: {
        flo_user_id: flo_user_id != null ? Number(flo_user_id) : existing.flo_user_id,
        cycle_start_date: cycle_start_date ? new Date(cycle_start_date) : existing.cycle_start_date,
        predicted_period_start: predicted_period_start ? new Date(predicted_period_start) : existing.predicted_period_start,
        predicted_period_end: predicted_period_end ? new Date(predicted_period_end) : existing.predicted_period_end,
        predicted_ovulation_date: predicted_ovulation_date ? new Date(predicted_ovulation_date) : existing.predicted_ovulation_date,
        fertile_window_start: fertile_window_start ? new Date(fertile_window_start) : existing.fertile_window_start,
        fertile_window_end: fertile_window_end ? new Date(fertile_window_end) : existing.fertile_window_end,
      },
      include: { flo_user: SAFE_FLO_USER_INCLUDE },
    });

    res.json(updatedPrediction);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update cycle prediction' });
  }
});

/**
 * Delete cycle prediction (owner or admin)
 */
router.delete('/:prediction_id', authenticateToken, async (req, res) => {
  try {
    const prediction_id = Number(req.params.prediction_id);
    if (Number.isNaN(prediction_id)) {
      return res.status(400).json({ error: 'prediction_id must be a number' });
    }

    const existing = await prisma.cycle_prediction.findUnique({
      where: { prediction_id },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Cycle prediction not found' });
    }
    if (!isAdmin(req) && !(await myFloUserIds(req)).includes(existing.flo_user_id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await prisma.cycle_prediction.delete({
      where: { prediction_id },
    });

    res.json({ message: 'Cycle prediction deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete cycle prediction' });
  }
});

export default router;
