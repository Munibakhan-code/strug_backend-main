import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { campaignPayoutSummary, withdrawCampaign } from '../utils/raise-payout.js';

const router = express.Router();

// Creator payouts for a Raise campaign. Owner-gated throughout — only the campaign owner may
// see its balance, withdraw funds, or read its payout history. Withdrawals credit the
// owner's strug_wallet net of a platform fee (see utils/raise-payout.js).

async function assertOwnsProject(project_id, userId) {
  const project = await prisma.projects.findUnique({ where: { project_id: Number(project_id) } });
  if (!project) return { code: 404, error: 'Campaign not found' };
  if (project.owner_user_id !== userId) return { code: 403, error: 'You do not own this campaign.' };
  return { project };
}

/* Withdrawable-balance summary (owner only) */
router.get('/project/:project_id/summary', authenticateToken, async (req, res) => {
  try {
    const project_id = Number(req.params.project_id);
    if (Number.isNaN(project_id)) return res.status(400).json({ error: 'project_id must be a number' });

    const owns = await assertOwnsProject(project_id, req.user.user_id);
    if (owns.error) return res.status(owns.code).json({ error: owns.error });

    const summary = await campaignPayoutSummary(project_id);
    if (!summary) return res.status(404).json({ error: 'Campaign not found' });

    const { project, ...rest } = summary;
    res.json(rest);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch payout summary' });
  }
});

/* Payout history (owner only) */
router.get('/project/:project_id', authenticateToken, async (req, res) => {
  try {
    const project_id = Number(req.params.project_id);
    if (Number.isNaN(project_id)) return res.status(400).json({ error: 'project_id must be a number' });

    const owns = await assertOwnsProject(project_id, req.user.user_id);
    if (owns.error) return res.status(owns.code).json({ error: owns.error });

    const payouts = await prisma.campaign_payout.findMany({
      where: { project_id },
      orderBy: { payout_id: 'desc' },
    });
    res.json(payouts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch payouts' });
  }
});

/* Withdraw the campaign's available balance to the owner's wallet (owner only) */
router.post('/project/:project_id/withdraw', authenticateToken, async (req, res) => {
  try {
    const project_id = Number(req.params.project_id);
    if (Number.isNaN(project_id)) return res.status(400).json({ error: 'project_id must be a number' });

    const owns = await assertOwnsProject(project_id, req.user.user_id);
    if (owns.error) return res.status(owns.code).json({ error: owns.error });

    const result = await withdrawCampaign(project_id, req.user.user_id);
    if (!result.ok) return res.status(result.code || 400).json({ error: result.message });

    res.status(201).json({
      successful: true,
      message: result.queued
        ? `Withdrawal request submitted for review (gross ${result.gross}, platform fee ${result.fee}, estimated net ${result.net}).`
        : `Withdrew ${result.net} to your wallet (gross ${result.gross}, platform fee ${result.fee}).`,
      payout: result.payout,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to process withdrawal' });
  }
});

export default router;
