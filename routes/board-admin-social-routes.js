// routes/board-admin-social-routes.js
//
// Internal Social Media team dashboard (strug-internal-dashboards → Social Media).
// Coordination for Strug's OWN brand social accounts + a content calendar. Board-authed
// CRUD, mounted at /board-admin/social; gated by authenticateBoard + requireManageMembers
// (the admin tier, like the other internal dashboards). Backed by the additive
// social_account + social_post tables. No external auth secrets are stored — this is a
// registry + planning tool, not an integration.

import express from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma-client.js';
import { authenticateBoard, requireDashboard } from '../middleware/authenticate-board.js';

const router = express.Router();
router.use(authenticateBoard, requireDashboard('social-media', 'read'));

const num = (d) => (d == null ? 0 : Number(d));
const PLATFORMS = ['instagram', 'x', 'tiktok', 'youtube', 'facebook', 'linkedin', 'threads', 'other'];
const ACCOUNT_STATUS = ['active', 'inactive'];
const POST_STATUS = ['idea', 'draft', 'scheduled', 'published', 'archived'];

// Resolve a set of board_member ids → { id: {member_id, name, email} } for display.
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
    const [accounts, byPlatform, followerAgg, postsByStatus, upcoming] = await Promise.all([
      prisma.social_account.count(),
      prisma.social_account.groupBy({ by: ['platform'], _count: { _all: true }, _sum: { follower_count: true } }),
      prisma.social_account.aggregate({ _sum: { follower_count: true } }),
      prisma.social_post.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.social_post.count({ where: { status: 'scheduled', scheduled_for: { gte: new Date() } } }),
    ]);
    const activeAccounts = await prisma.social_account.count({ where: { status: 'active' } });
    return res.status(200).json({
      successful: true,
      totals: {
        accounts,
        activeAccounts,
        totalFollowers: num(followerAgg._sum.follower_count),
        posts: postsByStatus.reduce((s, r) => s + num(r._count._all), 0),
        scheduledUpcoming: upcoming,
      },
      byPlatform: byPlatform
        .map((r) => ({ name: r.platform, count: num(r._count._all), followers: num(r._sum.follower_count) }))
        .sort((a, b) => b.count - a.count),
      postsByStatus: postsByStatus.map((r) => ({ name: r.status, count: num(r._count._all) })).sort((a, b) => b.count - a.count),
    });
  } catch (err) {
    console.error('[board-admin-social] overview error:', err);
    return res.status(500).json({ successful: false, message: 'Could not load social overview' });
  }
});

// ── Accounts ──────────────────────────────────────────────────────────────────────────
router.get('/accounts', async (req, res) => {
  const where = {};
  if (PLATFORMS.includes(req.query.platform)) where.platform = req.query.platform;
  if (ACCOUNT_STATUS.includes(req.query.status)) where.status = req.query.status;
  try {
    const accounts = await prisma.social_account.findMany({
      where,
      orderBy: [{ status: 'asc' }, { platform: 'asc' }, { created_at: 'desc' }],
      include: { _count: { select: { posts: true } } },
    });
    const mm = await memberMap(accounts.map((a) => a.managed_by));
    return res.status(200).json({
      successful: true,
      accounts: accounts.map((a) => ({ ...a, post_count: a._count.posts, manager: mm[a.managed_by] || null, _count: undefined })),
    });
  } catch (err) {
    console.error('[board-admin-social] accounts error:', err);
    return res.status(500).json({ successful: false, message: 'Could not load accounts' });
  }
});

const accountSchema = z.object({
  platform: z.enum(PLATFORMS),
  handle: z.string().trim().min(1).max(120),
  display_name: z.string().trim().max(160).optional().nullable(),
  url: z.string().trim().url().max(500).optional().nullable().or(z.literal('')),
  follower_count: z.number().int().min(0).optional().nullable(),
  status: z.enum(ACCOUNT_STATUS).optional(),
  managed_by: z.number().int().optional().nullable(),
  notes: z.string().trim().max(4000).optional().nullable(),
});
router.post('/accounts', requireDashboard('social-media', 'write'), async (req, res) => {
  const parsed = accountSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ successful: false, message: parsed.error.issues[0]?.message || 'Invalid input' });
  try {
    const d = parsed.data;
    const created = await prisma.social_account.create({
      data: { ...d, url: d.url || null, created_by: req.member.member_id },
    });
    return res.status(201).json({ successful: true, account: created });
  } catch (err) {
    console.error('[board-admin-social] create account error:', err);
    return res.status(500).json({ successful: false, message: 'Could not create account' });
  }
});
router.patch('/accounts/:id', requireDashboard('social-media', 'write'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ successful: false, message: 'Invalid id' });
  const parsed = accountSchema.partial().safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ successful: false, message: parsed.error.issues[0]?.message || 'Invalid input' });
  try {
    const data = { ...parsed.data };
    if (data.url === '') data.url = null;
    const updated = await prisma.social_account.update({ where: { id }, data });
    return res.status(200).json({ successful: true, account: updated });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ successful: false, message: 'Account not found' });
    console.error('[board-admin-social] update account error:', err);
    return res.status(500).json({ successful: false, message: 'Could not update account' });
  }
});
router.delete('/accounts/:id', requireDashboard('social-media', 'write'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ successful: false, message: 'Invalid id' });
  try {
    await prisma.social_account.delete({ where: { id } });
    return res.status(200).json({ successful: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ successful: false, message: 'Account not found' });
    console.error('[board-admin-social] delete account error:', err);
    return res.status(500).json({ successful: false, message: 'Could not delete account' });
  }
});

// ── Posts (content calendar) ──────────────────────────────────────────────────────────
router.get('/posts', async (req, res) => {
  const where = {};
  if (POST_STATUS.includes(req.query.status)) where.status = req.query.status;
  if (req.query.account_id && Number.isInteger(Number(req.query.account_id))) where.account_id = Number(req.query.account_id);
  if (req.query.campaign_id && Number.isInteger(Number(req.query.campaign_id))) where.campaign_id = Number(req.query.campaign_id);
  try {
    const posts = await prisma.social_post.findMany({
      where,
      orderBy: [{ scheduled_for: 'asc' }, { created_at: 'desc' }],
      include: {
        account: { select: { id: true, platform: true, handle: true } },
        campaign: { select: { id: true, name: true } },
      },
      take: 500,
    });
    const mm = await memberMap(posts.map((p) => p.assigned_to));
    return res.status(200).json({ successful: true, posts: posts.map((p) => ({ ...p, assignee: mm[p.assigned_to] || null })) });
  } catch (err) {
    console.error('[board-admin-social] posts error:', err);
    return res.status(500).json({ successful: false, message: 'Could not load posts' });
  }
});

const postSchema = z.object({
  account_id: z.number().int().optional().nullable(),
  campaign_id: z.number().int().optional().nullable(),
  title: z.string().trim().min(1).max(200),
  caption: z.string().trim().max(8000).optional().nullable(),
  media_url: z.string().trim().url().max(500).optional().nullable().or(z.literal('')),
  status: z.enum(POST_STATUS).optional(),
  scheduled_for: z.coerce.date().optional().nullable(),
  published_at: z.coerce.date().optional().nullable(),
  assigned_to: z.number().int().optional().nullable(),
});
router.post('/posts', requireDashboard('social-media', 'write'), async (req, res) => {
  const parsed = postSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ successful: false, message: parsed.error.issues[0]?.message || 'Invalid input' });
  try {
    const d = parsed.data;
    const created = await prisma.social_post.create({ data: { ...d, media_url: d.media_url || null, created_by: req.member.member_id } });
    return res.status(201).json({ successful: true, post: created });
  } catch (err) {
    console.error('[board-admin-social] create post error:', err);
    return res.status(500).json({ successful: false, message: 'Could not create post' });
  }
});
router.patch('/posts/:id', requireDashboard('social-media', 'write'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ successful: false, message: 'Invalid id' });
  const parsed = postSchema.partial().safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ successful: false, message: parsed.error.issues[0]?.message || 'Invalid input' });
  try {
    const data = { ...parsed.data };
    if (data.media_url === '') data.media_url = null;
    const updated = await prisma.social_post.update({ where: { id }, data });
    return res.status(200).json({ successful: true, post: updated });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ successful: false, message: 'Post not found' });
    console.error('[board-admin-social] update post error:', err);
    return res.status(500).json({ successful: false, message: 'Could not update post' });
  }
});
router.delete('/posts/:id', requireDashboard('social-media', 'write'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ successful: false, message: 'Invalid id' });
  try {
    await prisma.social_post.delete({ where: { id } });
    return res.status(200).json({ successful: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ successful: false, message: 'Post not found' });
    console.error('[board-admin-social] delete post error:', err);
    return res.status(500).json({ successful: false, message: 'Could not delete post' });
  }
});

export default router;
