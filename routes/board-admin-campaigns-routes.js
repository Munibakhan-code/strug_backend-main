// routes/board-admin-campaigns-routes.js
//
// Internal Campaign Management dashboard (strug-internal-dashboards → Campaign Management).
// The internal campaign team's marketing/growth campaign records. Board-authed CRUD,
// mounted at /board-admin/campaigns; gated by authenticateBoard + requireManageMembers.
// Backed by the additive internal_campaign table (social_post.campaign_id links content
// to a campaign).

import express from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma-client.js';
import { authenticateBoard, requireDashboard } from '../middleware/authenticate-board.js';

const router = express.Router();
router.use(authenticateBoard, requireDashboard('campaigns', 'read'));

const num = (d) => (d == null ? 0 : Number(d));
const CHANNELS = ['social', 'email', 'ads', 'referral', 'push', 'multi'];
const STATUSES = ['planning', 'active', 'paused', 'completed', 'cancelled'];

async function memberMap(ids) {
  const unique = [...new Set(ids.filter((x) => x != null))];
  if (!unique.length) return {};
  const members = await prisma.board_member.findMany({
    where: { member_id: { in: unique } },
    select: { member_id: true, name: true, email: true },
  });
  const map = {};
  for (const m of members) map[m.member_id] = m;
  return map;
}

// ── Overview ──────────────────────────────────────────────────────────────────────────
router.get('/overview', async (_req, res) => {
  try {
    const [total, byStatus, byChannel, budgetAgg, active] = await Promise.all([
      prisma.internal_campaign.count(),
      prisma.internal_campaign.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.internal_campaign.groupBy({ by: ['channel'], _count: { _all: true }, _sum: { budget: true, spend: true } }),
      prisma.internal_campaign.aggregate({ _sum: { budget: true, spend: true } }),
      prisma.internal_campaign.count({ where: { status: 'active' } }),
    ]);
    return res.status(200).json({
      successful: true,
      totals: {
        campaigns: total,
        active,
        totalBudget: num(budgetAgg._sum.budget),
        totalSpend: num(budgetAgg._sum.spend),
      },
      byStatus: byStatus.map((r) => ({ name: r.status, count: num(r._count._all) })).sort((a, b) => b.count - a.count),
      byChannel: byChannel
        .map((r) => ({ name: r.channel, count: num(r._count._all), budget: num(r._sum.budget), spend: num(r._sum.spend) }))
        .sort((a, b) => b.count - a.count),
    });
  } catch (err) {
    console.error('[board-admin-campaigns] overview error:', err);
    return res.status(500).json({ successful: false, message: 'Could not load campaigns overview' });
  }
});

// ── Campaigns list ────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const where = {};
  if (STATUSES.includes(req.query.status)) where.status = req.query.status;
  if (CHANNELS.includes(req.query.channel)) where.channel = req.query.channel;
  try {
    const campaigns = await prisma.internal_campaign.findMany({
      where,
      orderBy: [{ status: 'asc' }, { created_at: 'desc' }],
      include: { _count: { select: { posts: true } } },
    });
    const mm = await memberMap(campaigns.map((c) => c.owner));
    return res.status(200).json({
      successful: true,
      campaigns: campaigns.map((c) => ({
        ...c,
        budget: c.budget == null ? null : Number(c.budget),
        spend: c.spend == null ? null : Number(c.spend),
        post_count: c._count.posts,
        owner_member: mm[c.owner] || null,
        _count: undefined,
      })),
    });
  } catch (err) {
    console.error('[board-admin-campaigns] list error:', err);
    return res.status(500).json({ successful: false, message: 'Could not load campaigns' });
  }
});

const campaignSchema = z.object({
  name: z.string().trim().min(1).max(200),
  objective: z.string().trim().max(4000).optional().nullable(),
  channel: z.enum(CHANNELS).optional(),
  status: z.enum(STATUSES).optional(),
  start_date: z.coerce.date().optional().nullable(),
  end_date: z.coerce.date().optional().nullable(),
  budget: z.number().min(0).optional().nullable(),
  spend: z.number().min(0).optional().nullable(),
  owner: z.number().int().optional().nullable(),
  notes: z.string().trim().max(8000).optional().nullable(),
});
router.post('/', requireDashboard('campaigns', 'write'), async (req, res) => {
  const parsed = campaignSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ successful: false, message: parsed.error.issues[0]?.message || 'Invalid input' });
  try {
    const created = await prisma.internal_campaign.create({ data: { ...parsed.data, created_by: req.member.member_id } });
    return res.status(201).json({ successful: true, campaign: { ...created, budget: created.budget == null ? null : Number(created.budget), spend: created.spend == null ? null : Number(created.spend) } });
  } catch (err) {
    console.error('[board-admin-campaigns] create error:', err);
    return res.status(500).json({ successful: false, message: 'Could not create campaign' });
  }
});
router.patch('/:id', requireDashboard('campaigns', 'write'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ successful: false, message: 'Invalid id' });
  const parsed = campaignSchema.partial().safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ successful: false, message: parsed.error.issues[0]?.message || 'Invalid input' });
  try {
    const updated = await prisma.internal_campaign.update({ where: { id }, data: parsed.data });
    return res.status(200).json({ successful: true, campaign: { ...updated, budget: updated.budget == null ? null : Number(updated.budget), spend: updated.spend == null ? null : Number(updated.spend) } });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ successful: false, message: 'Campaign not found' });
    console.error('[board-admin-campaigns] update error:', err);
    return res.status(500).json({ successful: false, message: 'Could not update campaign' });
  }
});
router.delete('/:id', requireDashboard('campaigns', 'write'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ successful: false, message: 'Invalid id' });
  try {
    await prisma.internal_campaign.delete({ where: { id } });
    return res.status(200).json({ successful: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ successful: false, message: 'Campaign not found' });
    console.error('[board-admin-campaigns] delete error:', err);
    return res.status(500).json({ successful: false, message: 'Could not delete campaign' });
  }
});

export default router;
