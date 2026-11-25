import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

// Creator-authored progress updates for a Raise campaign. Public read (backers see them on
// the campaign page); owner-gated writes.

async function assertOwnsProject(project_id, userId) {
  const project = await prisma.projects.findUnique({ where: { project_id: Number(project_id) } });
  if (!project) return { code: 404, error: 'Campaign not found' };
  if (project.owner_user_id !== userId) return { code: 403, error: 'You do not own this campaign.' };
  return { project };
}

/* LIST a campaign's updates, newest first (public) */
router.get('/project/:project_id', async (req, res) => {
  try {
    const project_id = Number(req.params.project_id);
    if (Number.isNaN(project_id)) return res.status(400).json({ error: 'project_id must be a number' });

    const updates = await prisma.campaign_update.findMany({
      where: { project_id },
      orderBy: { update_id: 'desc' },
    });
    res.json(updates);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch campaign updates' });
  }
});

/* CREATE an update (owner only) */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { project_id, title, body } = req.body;

    const proj = Number(project_id);
    if (!Number.isInteger(proj)) return res.status(400).json({ error: 'A valid project_id is required.' });
    if (!body || !String(body).trim()) return res.status(400).json({ error: 'Update body is required.' });

    const owns = await assertOwnsProject(proj, req.user.user_id);
    if (owns.error) return res.status(owns.code).json({ error: owns.error });

    const update = await prisma.campaign_update.create({
      data: { project_id: proj, title: title ?? null, body: String(body) },
    });
    res.status(201).json(update);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create campaign update' });
  }
});

/* UPDATE an update (owner only) */
router.put('/:update_id', authenticateToken, async (req, res) => {
  try {
    const update_id = Number(req.params.update_id);
    if (Number.isNaN(update_id)) return res.status(400).json({ error: 'update_id must be a number' });

    const existing = await prisma.campaign_update.findUnique({ where: { update_id } });
    if (!existing) return res.status(404).json({ error: 'Update not found' });

    const owns = await assertOwnsProject(existing.project_id, req.user.user_id);
    if (owns.error) return res.status(owns.code).json({ error: owns.error });

    const { title, body } = req.body;
    const updated = await prisma.campaign_update.update({
      where: { update_id },
      data: {
        title: title ?? existing.title,
        body: body !== undefined ? String(body) : existing.body,
      },
    });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update campaign update' });
  }
});

/* DELETE an update (owner only) */
router.delete('/:update_id', authenticateToken, async (req, res) => {
  try {
    const update_id = Number(req.params.update_id);
    if (Number.isNaN(update_id)) return res.status(400).json({ error: 'update_id must be a number' });

    const existing = await prisma.campaign_update.findUnique({ where: { update_id } });
    if (!existing) return res.status(404).json({ error: 'Update not found' });

    const owns = await assertOwnsProject(existing.project_id, req.user.user_id);
    if (owns.error) return res.status(owns.code).json({ error: owns.error });

    await prisma.campaign_update.delete({ where: { update_id } });
    res.json({ message: 'Update deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete campaign update' });
  }
});

export default router;
