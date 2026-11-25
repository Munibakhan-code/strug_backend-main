import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { isAdmin } from '../middleware/require-admin.js';

const router = express.Router();

// Symptom logs are sensitive health data. Every route is scoped to the flo_user profiles the
// caller owns (flo_user.user_id === caller); an admin may see all.
async function myFloUserIds(req) {
  const rows = await prisma.flo_user.findMany({
    where: { user_id: req.user.user_id },
    select: { flo_user_id: true },
  });
  return rows.map((r) => r.flo_user_id);
}

//======================================================================================================
//=============================================== CRUD =================================================
//======================================================================================================

/* GET ALL SYMPTOM LOGS (own only; admin: all) */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const where = isAdmin(req) ? {} : { flo_user_id: { in: await myFloUserIds(req) } };
    const symptomLogs = await prisma.symptom_log.findMany({
      where,
      orderBy: { symptom_log_id: 'desc' },
      include: {
        flo_user: true,
        symptom_types: true,
      },
    });

    res.json(symptomLogs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch symptom logs' });
  }
});

/* GET SYMPTOM LOG BY ID (owner or admin) */
router.get('/:symptom_log_id', authenticateToken, async (req, res) => {
  try {
    const symptom_log_id = Number(req.params.symptom_log_id);

    if (Number.isNaN(symptom_log_id)) {
      return res.status(400).json({ error: 'symptom_log_id must be a number' });
    }

    const symptomLog = await prisma.symptom_log.findUnique({
      where: { symptom_log_id },
      include: {
        flo_user: true,
        symptom_types: true,
      },
    });

    if (!symptomLog) {
      return res.status(404).json({ error: 'Symptom log not found' });
    }
    if (!isAdmin(req) && !(await myFloUserIds(req)).includes(symptomLog.flo_user_id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    res.json(symptomLog);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch symptom log' });
  }
});

/* GET SYMPTOM LOGS BY FLO USER ID (must own that flo_user, or admin) */
router.get('/flo-user/:flo_user_id', authenticateToken, async (req, res) => {
  try {
    const flo_user_id = Number(req.params.flo_user_id);

    if (Number.isNaN(flo_user_id)) {
      return res.status(400).json({ error: 'flo_user_id must be a number' });
    }
    if (!isAdmin(req) && !(await myFloUserIds(req)).includes(flo_user_id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const symptomLogs = await prisma.symptom_log.findMany({
      where: { flo_user_id },
      orderBy: { date: 'desc' },
      include: {
        symptom_types: true,
      },
    });

    res.json(symptomLogs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch symptom logs for flo user' });
  }
});

/* CREATE SYMPTOM LOG (only for a flo_user the caller owns) */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { flo_user_id, symptom_type_id, date } = req.body;
    const targetFloId = Number(flo_user_id);
    if (Number.isNaN(targetFloId)) return res.status(400).json({ error: 'flo_user_id is required' });
    if (!isAdmin(req) && !(await myFloUserIds(req)).includes(targetFloId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const symptomLog = await prisma.symptom_log.create({
      data: {
        flo_user_id: targetFloId,
        symptom_type_id,
        date: date ? new Date(date) : new Date(),
      },
      include: {
        flo_user: true,
        symptom_types: true,
      },
    });

    res.status(201).json(symptomLog);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create symptom log' });
  }
});

/* UPDATE SYMPTOM LOG (owner or admin; cannot reassign to an unowned flo_user) */
router.put('/:symptom_log_id', authenticateToken, async (req, res) => {
  try {
    const symptom_log_id = Number(req.params.symptom_log_id);

    if (Number.isNaN(symptom_log_id)) {
      return res.status(400).json({ error: 'symptom_log_id must be a number' });
    }

    const { flo_user_id, symptom_type_id, date } = req.body;

    const existing = await prisma.symptom_log.findUnique({
      where: { symptom_log_id },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Symptom log not found' });
    }

    const ownedIds = isAdmin(req) ? null : await myFloUserIds(req);
    if (ownedIds && !ownedIds.includes(existing.flo_user_id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (flo_user_id != null && Number(flo_user_id) !== existing.flo_user_id
      && ownedIds && !ownedIds.includes(Number(flo_user_id))) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const updated = await prisma.symptom_log.update({
      where: { symptom_log_id },
      data: {
        flo_user_id: flo_user_id != null ? Number(flo_user_id) : existing.flo_user_id,
        symptom_type_id: symptom_type_id ?? existing.symptom_type_id,
        date: date ? new Date(date) : existing.date,
      },
      include: {
        flo_user: true,
        symptom_types: true,
      },
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update symptom log' });
  }
});

/* DELETE SYMPTOM LOG (owner or admin) */
router.delete('/:symptom_log_id', authenticateToken, async (req, res) => {
  try {
    const symptom_log_id = Number(req.params.symptom_log_id);

    if (Number.isNaN(symptom_log_id)) {
      return res.status(400).json({ error: 'symptom_log_id must be a number' });
    }

    const existing = await prisma.symptom_log.findUnique({
      where: { symptom_log_id },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Symptom log not found' });
    }
    if (!isAdmin(req) && !(await myFloUserIds(req)).includes(existing.flo_user_id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await prisma.symptom_log.delete({
      where: { symptom_log_id },
    });

    res.json({ message: 'Symptom log deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete symptom log' });
  }
});

//======================================================================================================
//=============================================== END CRUD =============================================
//======================================================================================================

export default router;
