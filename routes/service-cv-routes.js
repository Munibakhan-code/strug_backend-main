import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { isAdmin } from '../middleware/require-admin.js';

const router = express.Router();

function parseId(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : NaN;
}

async function assertOwnsProvider(provider_id, req) {
  const provider = await prisma.user_service_provider.findUnique({
    where: { provider_id },
    select: { provider_id: true, user_id: true },
  });
  if (!provider) return { error: 404, message: 'Provider not found' };
  if (!isAdmin(req) && provider.user_id !== req.user.user_id) {
    return { error: 403, message: 'Forbidden' };
  }
  return { provider };
}

/* GET ALL — own providers' CVs only (admin: all). Was unauthenticated dump. */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const where = isAdmin(req)
      ? {}
      : { user_service_provider: { user_id: req.user.user_id } };
    const cvs = await prisma.service_cv.findMany({
      where,
      orderBy: { cv_to_provider_id: 'desc' },
      include: {
        user_service_provider: true,
        service_type: true,
      },
      take: 100,
    });
    res.json(cvs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch service CVs' });
  }
});

/* GET CVS BY PROVIDER — owner or admin (must be before /:id) */
router.get('/provider/:provider_id', authenticateToken, async (req, res) => {
  try {
    const provider_id = parseId(req.params.provider_id);
    if (Number.isNaN(provider_id)) return res.status(400).json({ error: 'provider_id must be a number' });

    const gate = await assertOwnsProvider(provider_id, req);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });

    const cvs = await prisma.service_cv.findMany({
      where: { provider_id },
      include: { service_type: true },
      take: 100,
    });
    res.json(cvs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch CVs for provider' });
  }
});

/* GET CV BY ID — owner or admin */
router.get('/:cv_to_provider_id', authenticateToken, async (req, res) => {
  try {
    const cv_to_provider_id = parseId(req.params.cv_to_provider_id);
    if (Number.isNaN(cv_to_provider_id)) {
      return res.status(400).json({ error: 'cv_to_provider_id must be a number' });
    }

    const cv = await prisma.service_cv.findUnique({
      where: { cv_to_provider_id },
      include: {
        user_service_provider: true,
        service_type: true,
      },
    });

    if (!cv) return res.status(404).json({ error: 'CV not found' });
    if (!isAdmin(req) && cv.user_service_provider?.user_id !== req.user.user_id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.json(cv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch service CV' });
  }
});

/* CREATE — must own provider_id */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const provider_id = parseId(req.body.provider_id);
    if (Number.isNaN(provider_id)) return res.status(400).json({ error: 'provider_id is required' });
    if (!req.body.url) return res.status(400).json({ error: 'url is required' });

    const gate = await assertOwnsProvider(provider_id, req);
    if (gate.error) return res.status(gate.error).json({ error: gate.message });

    const cv = await prisma.service_cv.create({
      data: {
        provider_id,
        url: req.body.url,
        service_type_id: req.body.service_type_id != null ? Number(req.body.service_type_id) : null,
      },
      include: {
        user_service_provider: true,
        service_type: true,
      },
    });

    res.status(201).json(cv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create service CV' });
  }
});

/* UPDATE — owner or admin */
router.put('/:cv_to_provider_id', authenticateToken, async (req, res) => {
  try {
    const cv_to_provider_id = parseId(req.params.cv_to_provider_id);
    if (Number.isNaN(cv_to_provider_id)) {
      return res.status(400).json({ error: 'cv_to_provider_id must be a number' });
    }

    const existing = await prisma.service_cv.findUnique({
      where: { cv_to_provider_id },
      include: { user_service_provider: { select: { user_id: true } } },
    });
    if (!existing) return res.status(404).json({ error: 'CV not found' });
    if (!isAdmin(req) && existing.user_service_provider?.user_id !== req.user.user_id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    let nextProviderId = existing.provider_id;
    if (req.body.provider_id != null) {
      const candidate = parseId(req.body.provider_id);
      if (Number.isNaN(candidate)) return res.status(400).json({ error: 'provider_id must be a number' });
      const gate = await assertOwnsProvider(candidate, req);
      if (gate.error) return res.status(gate.error).json({ error: gate.message });
      nextProviderId = candidate;
    }

    const updated = await prisma.service_cv.update({
      where: { cv_to_provider_id },
      data: {
        provider_id: nextProviderId,
        url: req.body.url ?? existing.url,
        service_type_id: req.body.service_type_id ?? existing.service_type_id,
      },
      include: {
        user_service_provider: true,
        service_type: true,
      },
    });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update service CV' });
  }
});

/* DELETE — owner or admin */
router.delete('/:cv_to_provider_id', authenticateToken, async (req, res) => {
  try {
    const cv_to_provider_id = parseId(req.params.cv_to_provider_id);
    if (Number.isNaN(cv_to_provider_id)) {
      return res.status(400).json({ error: 'cv_to_provider_id must be a number' });
    }

    const existing = await prisma.service_cv.findUnique({
      where: { cv_to_provider_id },
      include: { user_service_provider: { select: { user_id: true } } },
    });
    if (!existing) return res.status(404).json({ error: 'CV not found' });
    if (!isAdmin(req) && existing.user_service_provider?.user_id !== req.user.user_id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await prisma.service_cv.delete({ where: { cv_to_provider_id } });
    res.json({ message: 'Service CV deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete service CV' });
  }
});

export default router;
