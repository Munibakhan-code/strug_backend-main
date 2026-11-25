import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { slugify } from '../utils/slugify.js';

const router = express.Router();
const CAMPAIGN_STATUSES = new Set(['draft', 'live', 'paused', 'completed', 'cancelled']);
const CAMPAIGN_TYPES = new Set(['fundraiser', 'campaign']);

function cleanText(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || null;
}

function normalizeCampaignType(v) {
  const s = String(v || '').trim().toLowerCase();
  return CAMPAIGN_TYPES.has(s) ? s : 'fundraiser';
}

function normalizeCampaignStatus(v, fallback = 'draft') {
  const s = String(v || '').trim().toLowerCase();
  return CAMPAIGN_STATUSES.has(s) ? s : fallback;
}

async function uniqueProjectSlug(raw, excludeId = null) {
  const base = slugify(raw || 'campaign', 72);
  let next = base;
  let i = 2;
  while (true) {
    const existing = await prisma.projects.findFirst({
      where: {
        slug: next,
        ...(excludeId ? { NOT: { project_id: Number(excludeId) } } : {}),
      },
      select: { project_id: true },
    });
    if (!existing) return next;
    next = `${base}-${i++}`;
  }
}

function buildPublicBrowseWhere(query = {}) {
  const now = new Date();
  const where = {
    status: 'live',
    review_status: 'approved',
    is_hidden: false,
  };
  const and = [];
  const q = String(query.q || '').trim();
  if (q) {
    and.push({
      OR: [
        { title: { contains: q, mode: 'insensitive' } },
        { project_name: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
      ],
    });
  }
  const category = cleanText(query.category);
  if (category) and.push({ category });
  const campaign_type = normalizeCampaignType(query.campaign_type);
  if (query.campaign_type) and.push({ campaign_type });
  if (String(query.ending_soon || '').toLowerCase() === 'true') {
    const soon = new Date(Date.now() + (14 * 86400000));
    and.push({ deadline: { gte: now, lte: soon } });
  }
  if (String(query.funded || '').toLowerCase() === 'true') {
    and.push({
      AND: [
        { expected_amount: { gt: 0 } },
        { current_amount: { gte: 0 } },
      ],
    });
  }
  if (and.length) where.AND = and;
  return where;
}

function statePatchForStatus(status, existing = null) {
  const now = new Date();
  const next = normalizeCampaignStatus(status, existing?.status || 'draft');
  if (next === 'live') {
    return {
      status: 'live',
      review_status: 'approved',
      submitted_at: existing?.submitted_at || now,
      published_at: existing?.published_at || now,
      approved_at: existing?.approved_at || now,
      rejected_at: null,
    };
  }
  if (next === 'completed') {
    return { status: 'completed', completed_at: existing?.completed_at || now };
  }
  if (next === 'paused') return { status: 'paused' };
  if (next === 'cancelled') return { status: 'cancelled', completed_at: existing?.completed_at || now };
  return { status: 'draft' };
}

//======================================================================================================
//=============================================== CRUD =================================================
//======================================================================================================

/* GET ALL PROJECTS (public browse grid) */
router.get('/', async (_req, res) => {
  try {
    const projects = await prisma.projects.findMany({
      where: buildPublicBrowseWhere(_req.query),
      orderBy: [{ is_featured: 'desc' }, { project_id: 'desc' }],
      include: {
        user: true,
        // Public browse: expose only non-PII donation fields (backer count + amounts).
        // Never leak donor shipping_*, shipping_email, payment_intent_id, referral_code, etc.
        donations: {
          where: { payment_status: 'paid', refund_status: { not: 'refunded' } },
          select: { donation_id: true, amount: true, donated_date: true, payment_status: true, refund_status: true, reward_tier_id: true },
        },
        reward_tiers: true,
      },
    });

    res.json(projects);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

/* GET MY PROJECTS — only the authenticated creator's own campaigns.
   Registered before "/:project_id" so "mine" isn't parsed as an id. */
router.get('/mine', authenticateToken, async (req, res) => {
  try {
    const projects = await prisma.projects.findMany({
      where: { owner_user_id: req.user.user_id },
      orderBy: { project_id: 'desc' },
      include: {
        donations: true,
        reward_tiers: true,
        campaign_updates: true,
      },
    });
    res.json(projects);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

/* GET PROJECT BY ID */
router.get('/:project_id', async (req, res) => {
  try {
    const project_id = Number(req.params.project_id);

    if (Number.isNaN(project_id)) {
      return res.status(400).json({ error: 'project_id must be a number' });
    }

    const project = await prisma.projects.findUnique({
      where: { project_id },
      include: {
        user: true,
        // Public detail: non-PII donation fields only (backer count/amounts).
        // Donor PII (shipping_*, email, payment_intent_id, referral_code) stays on the
        // authenticated owner/admin backers route (/donation/project/:id/backers).
        donations: {
          where: { payment_status: 'paid', refund_status: { not: 'refunded' } },
          select: { donation_id: true, amount: true, donated_date: true, payment_status: true, refund_status: true, reward_tier_id: true },
        },
        reward_tiers: true,
        campaign_updates: true,
      },
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (
      project.status !== 'live'
      || project.review_status !== 'approved'
      || project.is_hidden
    ) {
      return res.status(404).json({ error: 'Project not found' });
    }

    res.json(project);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch project' });
  }
});

/* CREATE PROJECT */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const {
      project_name, title, description, expected_amount, deadline, cover_url,
      category, campaign_type, status,
    } = req.body;

    const goal = Number(expected_amount);
    if (!Number.isFinite(goal) || goal <= 0) {
      return res.status(400).json({ error: 'expected_amount must be a positive number' });
    }
    const nextTitle = cleanText(title || project_name);
    const nextSlug = await uniqueProjectSlug(nextTitle || 'campaign');
    const type = normalizeCampaignType(campaign_type);
    const state = statePatchForStatus(status || 'draft');

    // The owner is ALWAYS the authenticated user — never trust a client-supplied id.
    // current_amount/posted_date are server-owned financial/audit state.
    const project = await prisma.projects.create({
      data: {
        project_name: cleanText(project_name),
        owner_user_id: req.user.user_id,
        title: nextTitle,
        description: cleanText(description),
        expected_amount: goal,
        posted_date: new Date(),
        current_amount: 0,
        deadline: deadline ? new Date(deadline) : undefined,
        cover_url: typeof cover_url === 'string' && cover_url.trim() ? cover_url.trim() : undefined,
        slug: nextSlug,
        category: cleanText(category) || 'Community',
        campaign_type: type,
        ...state,
      },
      include: {
        user: true,
      },
    });

    res.status(201).json(project);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create project' });
  }
});

/* UPDATE PROJECT — only the owner may edit, and only editable fields. */
router.put('/:project_id', authenticateToken, async (req, res) => {
  try {
    const project_id = Number(req.params.project_id);

    if (Number.isNaN(project_id)) {
      return res.status(400).json({ error: 'project_id must be a number' });
    }

    const existing = await prisma.projects.findUnique({ where: { project_id } });
    if (!existing) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (existing.owner_user_id !== req.user.user_id) {
      return res.status(403).json({ error: 'You do not own this campaign.' });
    }

    const { project_name, title, description, expected_amount, deadline, cover_url, category, campaign_type, status } = req.body;

    // owner_user_id, current_amount and posted_date are intentionally NOT updatable from
    // the client — ownership is fixed, funds are derived from confirmed donations.
    let goal = existing.expected_amount;
    if (expected_amount !== undefined) {
      const parsed = Number(expected_amount);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return res.status(400).json({ error: 'expected_amount must be a positive number' });
      }
      goal = parsed;
    }

    // cover_url: allow set (non-empty string), clear (null), or leave unchanged (undefined).
    let nextCover = existing.cover_url;
    if (cover_url !== undefined) {
      nextCover = typeof cover_url === 'string' && cover_url.trim() ? cover_url.trim() : null;
    }

    const nextTitle = title ?? project_name ?? existing.title ?? existing.project_name;
    const nextSlug = req.body.slug !== undefined
      ? await uniqueProjectSlug(cleanText(req.body.slug) || nextTitle || 'campaign', project_id)
      : ((title !== undefined || project_name !== undefined)
        ? await uniqueProjectSlug(nextTitle || 'campaign', project_id)
        : existing.slug);
    const updated = await prisma.projects.update({
      where: { project_id },
      data: {
        project_name: project_name !== undefined ? cleanText(project_name) : existing.project_name,
        title: title !== undefined ? cleanText(title) : existing.title,
        description: description !== undefined ? cleanText(description) : existing.description,
        expected_amount: goal,
        deadline: deadline ? new Date(deadline) : existing.deadline,
        cover_url: nextCover,
        slug: nextSlug,
        category: category !== undefined ? (cleanText(category) || 'Community') : existing.category,
        campaign_type: campaign_type !== undefined ? normalizeCampaignType(campaign_type) : existing.campaign_type,
        ...statePatchForStatus(status, existing),
      },
      include: {
        user: true,
        donations: true,
      },
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update project' });
  }
});

/* DELETE PROJECT — only the owner may delete. */
router.delete('/:project_id', authenticateToken, async (req, res) => {
  try {
    const project_id = Number(req.params.project_id);

    if (Number.isNaN(project_id)) {
      return res.status(400).json({ error: 'project_id must be a number' });
    }

    const existing = await prisma.projects.findUnique({ where: { project_id } });
    if (!existing) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (existing.owner_user_id !== req.user.user_id) {
      return res.status(403).json({ error: 'You do not own this campaign.' });
    }
    const paidCount = await prisma.donations.count({
      where: { project_id, payment_status: 'paid', refund_status: { not: 'refunded' } },
    });
    if (paidCount > 0) {
      return res.status(409).json({ error: 'Campaigns with paid backers must be archived instead of deleted.' });
    }

    await prisma.projects.delete({ where: { project_id } });

    res.json({ message: 'Project deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete project' });
  }
});

//======================================================================================================
//=============================================== END CRUD =============================================
//======================================================================================================

export default router;
