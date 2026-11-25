import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

// GET /work-categories — macro categories (parent_id NULL) each with their leaf
// worker-types. Returns is_live so the client/admin can filter to the launch set.
router.get('/', authenticateToken, async (req, res) => {
  try {
    const cats = await prisma.work_category.findMany({
      where: { is_active: true },
      orderBy: { work_category_id: 'asc' },
      select: { work_category_id: true, parent_id: true, name: true, slug: true, icon_url: true, is_live: true },
    });
    const macros = cats.filter((c) => c.parent_id == null);
    const byParent = {};
    for (const c of cats) {
      if (c.parent_id != null) (byParent[c.parent_id] = byParent[c.parent_id] || []).push(c);
    }
    const result = macros.map((m) => ({ ...m, children: byParent[m.work_category_id] || [] }));
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to fetch work categories' });
  }
});

export default router;
