import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

// Reward / pledge tiers for a Raise campaign. Public read; owner-gated writes (the caller
// must own the parent campaign). claimed_count is server-owned — it is only moved when a
// paid donation claims a tier (see donation-routes.js), never set from the client.

// Confirm the authenticated user owns the campaign the tier belongs (or will belong) to.
async function assertOwnsProject(project_id, userId) {
  const project = await prisma.projects.findUnique({ where: { project_id: Number(project_id) } });
  if (!project) return { code: 404, error: 'Campaign not found' };
  if (project.owner_user_id !== userId) return { code: 403, error: 'You do not own this campaign.' };
  return { project };
}

/* LIST a campaign's tiers (public) */
router.get('/project/:project_id', async (req, res) => {
  try {
    const project_id = Number(req.params.project_id);
    if (Number.isNaN(project_id)) return res.status(400).json({ error: 'project_id must be a number' });

    const tiers = await prisma.reward_tier.findMany({
      where: { project_id },
      orderBy: [{ sort_order: 'asc' }, { amount: 'asc' }],
    });
    res.json(tiers);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch reward tiers' });
  }
});

/* CREATE a tier (owner only) */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { project_id, title, description, amount, reward_description, quantity_limit, sort_order } = req.body;

    const proj = Number(project_id);
    if (!Number.isInteger(proj)) return res.status(400).json({ error: 'A valid project_id is required.' });

    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'amount must be a positive number' });

    const owns = await assertOwnsProject(proj, req.user.user_id);
    if (owns.error) return res.status(owns.code).json({ error: owns.error });

    let limit = null;
    if (quantity_limit !== undefined && quantity_limit !== null && quantity_limit !== '') {
      limit = Number(quantity_limit);
      if (!Number.isInteger(limit) || limit < 0) return res.status(400).json({ error: 'quantity_limit must be a non-negative integer' });
    }

    const tier = await prisma.reward_tier.create({
      data: {
        project_id: proj,
        title: title ?? null,
        description: description ?? null,
        amount: amt,
        reward_description: reward_description ?? null,
        quantity_limit: limit,
        sort_order: Number.isInteger(Number(sort_order)) ? Number(sort_order) : 0,
      },
    });
    res.status(201).json(tier);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create reward tier' });
  }
});

/* UPDATE a tier (owner only) */
router.put('/:tier_id', authenticateToken, async (req, res) => {
  try {
    const tier_id = Number(req.params.tier_id);
    if (Number.isNaN(tier_id)) return res.status(400).json({ error: 'tier_id must be a number' });

    const existing = await prisma.reward_tier.findUnique({ where: { tier_id } });
    if (!existing) return res.status(404).json({ error: 'Reward tier not found' });

    const owns = await assertOwnsProject(existing.project_id, req.user.user_id);
    if (owns.error) return res.status(owns.code).json({ error: owns.error });

    const { title, description, amount, reward_description, quantity_limit, sort_order } = req.body;

    let amt = existing.amount;
    if (amount !== undefined) {
      amt = Number(amount);
      if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'amount must be a positive number' });
    }

    let limit = existing.quantity_limit;
    if (quantity_limit !== undefined) {
      if (quantity_limit === null || quantity_limit === '') {
        limit = null;
      } else {
        limit = Number(quantity_limit);
        if (!Number.isInteger(limit) || limit < 0) return res.status(400).json({ error: 'quantity_limit must be a non-negative integer' });
      }
    }

    // claimed_count, project_id are server-owned — not updatable from the client.
    const updated = await prisma.reward_tier.update({
      where: { tier_id },
      data: {
        title: title ?? existing.title,
        description: description ?? existing.description,
        amount: amt,
        reward_description: reward_description ?? existing.reward_description,
        quantity_limit: limit,
        sort_order: Number.isInteger(Number(sort_order)) ? Number(sort_order) : existing.sort_order,
      },
    });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update reward tier' });
  }
});

/* DELETE a tier (owner only) */
router.delete('/:tier_id', authenticateToken, async (req, res) => {
  try {
    const tier_id = Number(req.params.tier_id);
    if (Number.isNaN(tier_id)) return res.status(400).json({ error: 'tier_id must be a number' });

    const existing = await prisma.reward_tier.findUnique({ where: { tier_id } });
    if (!existing) return res.status(404).json({ error: 'Reward tier not found' });

    const owns = await assertOwnsProject(existing.project_id, req.user.user_id);
    if (owns.error) return res.status(owns.code).json({ error: owns.error });

    // Detach any donations that referenced this tier so their history survives the delete.
    await prisma.donations.updateMany({ where: { reward_tier_id: tier_id }, data: { reward_tier_id: null } });
    await prisma.reward_tier.delete({ where: { tier_id } });
    res.json({ message: 'Reward tier deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete reward tier' });
  }
});

export default router;
