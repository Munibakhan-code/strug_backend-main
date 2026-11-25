import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

function isAdmin(req) {
  return req.user?.role === 'ADMIN' || req.user?.permission === 'admin';
}

/* GET ALL SHARED REF CODES — admin or own shares only */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const where = isAdmin(req)
      ? {}
      : { OR: [{ shared_to: req.user.user_id }, { ref_code: req.user.ref_code || undefined }].filter((c) => Object.values(c)[0] != null) };
    const sharedRefCodes = await prisma.shared_ref_code.findMany({
      where,
      orderBy: { share_id: 'desc' },
      include: {
        checkouts: true,
      },
    });

    res.json(sharedRefCodes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch shared ref codes' });
  }
});

/* GET BY REF CODE — public lookup for applying a share (must be before /:share_id) */
router.get('/code/:ref_code', async (req, res) => {
  try {
    const { ref_code } = req.params;

    const sharedRefCode = await prisma.shared_ref_code.findUnique({
      where: { ref_code },
      include: {
        checkouts: true,
      },
    });

    if (!sharedRefCode) {
      return res.status(404).json({ error: 'Shared ref code not found' });
    }

    res.json(sharedRefCode);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch shared ref code' });
  }
});

/* GET SHARED REF CODE BY ID */
router.get('/:share_id', authenticateToken, async (req, res) => {
  try {
    const share_id = Number(req.params.share_id);

    if (Number.isNaN(share_id)) {
      return res.status(400).json({ error: 'share_id must be a number' });
    }

    const sharedRefCode = await prisma.shared_ref_code.findUnique({
      where: { share_id },
      include: {
        checkouts: true,
      },
    });

    if (!sharedRefCode) {
      return res.status(404).json({ error: 'Shared ref code not found' });
    }
    if (!isAdmin(req)
      && sharedRefCode.shared_to !== req.user.user_id
      && sharedRefCode.ref_code !== req.user.ref_code) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    res.json(sharedRefCode);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch shared ref code' });
  }
});

/* CREATE SHARED REF CODE */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { shared_to, ref_code } = req.body;

    const sharedRefCode = await prisma.shared_ref_code.create({
      data: {
        shared_to: shared_to != null ? Number(shared_to) : req.user.user_id,
        ref_code: ref_code || req.user.ref_code,
      },
    });

    res.status(201).json(sharedRefCode);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create shared ref code' });
  }
});

/* UPDATE SHARED REF CODE */
router.put('/:share_id', authenticateToken, async (req, res) => {
  try {
    const share_id = Number(req.params.share_id);

    if (Number.isNaN(share_id)) {
      return res.status(400).json({ error: 'share_id must be a number' });
    }

    const { shared_to, ref_code } = req.body;

    const existing = await prisma.shared_ref_code.findUnique({
      where: { share_id },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Shared ref code not found' });
    }
    if (!isAdmin(req)
      && existing.shared_to !== req.user.user_id
      && existing.ref_code !== req.user.ref_code) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const updated = await prisma.shared_ref_code.update({
      where: { share_id },
      data: {
        shared_to: shared_to ?? existing.shared_to,
        ref_code: ref_code ?? existing.ref_code,
      },
      include: {
        checkouts: true,
      },
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update shared ref code' });
  }
});

/* DELETE SHARED REF CODE */
router.delete('/:share_id', authenticateToken, async (req, res) => {
  try {
    const share_id = Number(req.params.share_id);

    if (Number.isNaN(share_id)) {
      return res.status(400).json({ error: 'share_id must be a number' });
    }

    const existing = await prisma.shared_ref_code.findUnique({ where: { share_id } });
    if (!existing) return res.status(404).json({ error: 'Shared ref code not found' });
    if (!isAdmin(req)
      && existing.shared_to !== req.user.user_id
      && existing.ref_code !== req.user.ref_code) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await prisma.shared_ref_code.delete({
      where: { share_id },
    });

    res.json({ message: 'Shared ref code deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete shared ref code' });
  }
});

export default router;
