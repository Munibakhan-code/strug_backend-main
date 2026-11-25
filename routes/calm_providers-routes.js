// routes/calmProviders.js
import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/**
 * Get all calm providers
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const providers = await prisma.calm_providers.findMany({
      orderBy: { calm_provider_id: 'desc' },
      include: {
        calm_category: true,
        // Public provider directory — never serialize the full user (email/phone/KYC/DOB).
        user: { select: { user_id: true, name: true, username: true } },
      },
    });

    res.json(providers);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch calm providers' });
  }
});

/**
 * Get single calm provider
 */
router.get('/:calm_provider_id', authenticateToken, async (req, res) => {
  try {
    const provider = await prisma.calm_providers.findUnique({
      where: { calm_provider_id: Number(req.params.calm_provider_id) },
      include: {
        calm_category: true,
        // Public provider directory — never serialize the full user (email/phone/KYC/DOB).
        user: { select: { user_id: true, name: true, username: true } },
      },
    });

    if (!provider) return res.status(404).json({ error: 'Calm provider not found' });

    res.json(provider);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch calm provider' });
  }
});

/**
 * Create new calm provider
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { provider_user_id, calm_provider_category_id } = req.body;

    if (!provider_user_id) {
      return res.status(400).json({ error: 'provider_user_id is required' });
    }

    const newProvider = await prisma.calm_providers.create({
      data: {
        provider_user_id: Number(provider_user_id),
        calm_provider_category_id: calm_provider_category_id ? Number(calm_provider_category_id) : null,
      },
    });

    io?.emit('calm-provider-created', newProvider);

    res.status(201).json(newProvider);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create calm provider' });
  }
});

/**
 * Update calm provider
 */
router.put('/:calm_provider_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { calm_provider_id } = req.params;
    const { provider_user_id, calm_provider_category_id } = req.body;

    const existing = await prisma.calm_providers.findUnique({
      where: { calm_provider_id: Number(calm_provider_id) },
    });

    if (!existing) return res.status(404).json({ error: 'Calm provider not found' });

    const updatedProvider = await prisma.calm_providers.update({
      where: { calm_provider_id: Number(calm_provider_id) },
      data: {
        provider_user_id: provider_user_id ? Number(provider_user_id) : existing.provider_user_id,
        calm_provider_category_id: calm_provider_category_id ? Number(calm_provider_category_id) : existing.calm_provider_category_id,
      },
    });

    io?.emit('calm-provider-updated', updatedProvider);

    res.json(updatedProvider);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update calm provider' });
  }
});

/**
 * Delete calm provider
 */
router.delete('/:calm_provider_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const deleted = await prisma.calm_providers.delete({
      where: { calm_provider_id: Number(req.params.calm_provider_id) },
    });

    io?.emit('calm-provider-deleted', { calm_provider_id: deleted.calm_provider_id });

    res.json({ message: 'Calm provider deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete calm provider' });
  }
});

export default router;