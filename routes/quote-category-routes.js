import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

// GET /quote-categories — Insurance & Mortgage macros (parent_id NULL) each with their
// leaf sub-types. Includes form_schema (the dynamic request-form fields) so the request
// builder and provider onboarding can both consume it. Optional ?vertical=insurance|mortgage
// and ?live=1 (launch set only) filters.
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { vertical, live } = req.query;
    const where = { is_active: true };
    if (vertical) where.vertical = String(vertical);
    if (live === '1' || live === 'true') where.is_live = true;

    const cats = await prisma.quote_category.findMany({
      where,
      orderBy: { quote_category_id: 'asc' },
      select: {
        quote_category_id: true,
        parent_id: true,
        name: true,
        slug: true,
        vertical: true,
        icon_url: true,
        form_schema: true,
        is_live: true,
      },
    });

    const macros = cats.filter((c) => c.parent_id == null);
    const byParent = {};
    for (const c of cats) {
      if (c.parent_id != null) (byParent[c.parent_id] = byParent[c.parent_id] || []).push(c);
    }
    const result = macros.map((m) => ({ ...m, children: byParent[m.quote_category_id] || [] }));
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to fetch quote categories' });
  }
});

export default router;
