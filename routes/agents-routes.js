// routes/agents.js — employer profiles for the jobs vertical
import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

// Editable employer fields (agent_user_id is derived from the token, never the body).
const EMPLOYER_FIELDS = [
  'company_name', 'company_web_url', 'company_country', 'role',
  'company_logo_url', 'company_description', 'company_size', 'industry',
];

function pickEmployer(body) {
  const data = {};
  for (const key of EMPLOYER_FIELDS) {
    if (body[key] !== undefined) data[key] = body[key];
  }
  return data;
}

/**
 * Get all agents
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const agents = await prisma.agents.findMany({
      orderBy: { agent_id: 'desc' },
      include: {
        user: true,
      },
    });

    res.json(agents);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch agents' });
  }
});

/**
 * Get the caller's own employer profile (or null). Declared before /:agent_id.
 */
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const agent = await prisma.agents.findFirst({
      where: { agent_user_id: Number(req.user.user_id) },
      include: { user: true },
    });
    res.json(agent || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch your employer profile' });
  }
});

/** Public company card fields — never include user/email. */
const PUBLIC_AGENT_SELECT = {
  agent_id: true,
  company_name: true,
  company_web_url: true,
  company_country: true,
  company_logo_url: true,
  company_description: true,
  company_size: true,
  industry: true,
};

/**
 * Companies currently hiring (open roles). Public discovery rail.
 */
router.get('/hiring', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 24);
    const rows = await prisma.jobs.groupBy({
      by: ['agent_id'],
      where: { status: 'open', agent_id: { not: null } },
      _count: { job_id: true },
      orderBy: { _count: { job_id: 'desc' } },
      take: limit,
    });
    const ids = rows.map((r) => r.agent_id).filter(Boolean);
    if (!ids.length) return res.json([]);

    const agents = await prisma.agents.findMany({
      where: { agent_id: { in: ids } },
      select: PUBLIC_AGENT_SELECT,
    });
    const byId = Object.fromEntries(agents.map((a) => [a.agent_id, a]));
    const out = rows
      .map((r) => {
        const a = byId[r.agent_id];
        if (!a || !a.company_name) return null;
        return { ...a, open_count: r._count.job_id };
      })
      .filter(Boolean);
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch hiring companies' });
  }
});

/**
 * Public company profile + open roles (no auth, no user PII).
 */
router.get('/:agent_id/public', async (req, res) => {
  try {
    const agentId = Number(req.params.agent_id);
    if (!Number.isFinite(agentId) || agentId <= 0) {
      return res.status(400).json({ error: 'Invalid company id' });
    }
    const agent = await prisma.agents.findUnique({
      where: { agent_id: agentId },
      select: PUBLIC_AGENT_SELECT,
    });
    if (!agent) return res.status(404).json({ error: 'Company not found' });

    const jobs = await prisma.jobs.findMany({
      where: { agent_id: agentId, status: 'open' },
      orderBy: [{ posted_date: 'desc' }, { job_id: 'desc' }],
      take: 50,
      include: {
        job_categories: true,
        agents: { select: PUBLIC_AGENT_SELECT },
      },
    });

    res.json({ ...agent, jobs, open_count: jobs.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch company profile' });
  }
});

/**
 * Get single agent by agent_id
 */
router.get('/:agent_id', authenticateToken, async (req, res) => {
  try {
    const agent = await prisma.agents.findUnique({
      where: { agent_id: Number(req.params.agent_id) },
      include: {
        user: true,
      },
    });

    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    res.json(agent);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch agent' });
  }
});

/**
 * Create employer profile for the caller (agent_user_id comes from the token).
 * One profile per user — returns the existing one rather than duplicating.
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const userId = Number(req.user.user_id);

    const existing = await prisma.agents.findFirst({ where: { agent_user_id: userId } });
    if (existing) return res.status(200).json(existing);

    const newAgent = await prisma.agents.create({
      data: {
        agent_user_id: userId,
        ...pickEmployer(req.body),
      },
    });

    io?.emit('agent-created', newAgent);

    res.status(201).json(newAgent);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create agent' });
  }
});

/**
 * Update employer profile — only the owner may edit.
 */
router.put('/:agent_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { agent_id } = req.params;

    const existing = await prisma.agents.findUnique({
      where: { agent_id: Number(agent_id) },
    });

    if (!existing) return res.status(404).json({ error: 'Agent not found' });
    if (existing.agent_user_id !== Number(req.user.user_id)) {
      return res.status(403).json({ error: 'Not authorised to edit this employer profile' });
    }

    const updatedAgent = await prisma.agents.update({
      where: { agent_id: Number(agent_id) },
      data: pickEmployer(req.body),
    });

    io?.emit('agent-updated', updatedAgent);

    res.json(updatedAgent);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update agent' });
  }
});

/**
 * Delete employer profile — only the owner may delete.
 */
router.delete('/:agent_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const existing = await prisma.agents.findUnique({
      where: { agent_id: Number(req.params.agent_id) },
    });
    if (!existing) return res.status(404).json({ error: 'Agent not found' });
    if (existing.agent_user_id !== Number(req.user.user_id)) {
      return res.status(403).json({ error: 'Not authorised to delete this employer profile' });
    }

    const deleted = await prisma.agents.delete({
      where: { agent_id: Number(req.params.agent_id) },
    });

    io?.emit('agent-deleted', { agent_id: deleted.agent_id });

    res.json({ message: 'Agent deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete agent' });
  }
});

export default router;
