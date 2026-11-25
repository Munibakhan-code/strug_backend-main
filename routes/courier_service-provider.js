import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

// Backed by driver_profile + driver_courier_profile now (unified driver identity), but every
// response keeps the flat courier_service_provider shape callers already expect.
const COURIER_INCLUDE = { user: true, driver_courier_profile: true, courier_order: true };

function flattenCourierProvider(profile) {
  if (!profile) return null;
  const ext = profile.driver_courier_profile;
  return {
    courier_service_provider_id: profile.driver_profile_id,
    courier_service_provider_name: ext?.display_name ?? null,
    courier_service_provider_user_id: profile.user_id,
    price_per_km: ext?.price_per_km ?? null,
    user: profile.user,
    courier_order: profile.courier_order,
  };
}

/**
 * Get all courier service providers
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const profiles = await prisma.driver_profile.findMany({
      where: { driver_courier_profile: { isNot: null } },
      orderBy: { driver_profile_id: 'asc' },
      include: COURIER_INCLUDE,
    });

    res.json(profiles.map(flattenCourierProvider));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch courier service providers' });
  }
});

/**
 * Get-or-create the authenticated user's courier provider record (driver_profile +
 * driver_courier_profile). user_id is taken from the token, never the body. This is what makes
 * a user an eligible courier (the available-orders feed + accept/pickup/deliver require it).
 * Registered before "/:courier_service_provider_id" so "me" isn't parsed as an id.
 */
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const user_id = req.user.user_id;

    let driverProfile = await prisma.driver_profile.findFirst({ where: { user_id } });
    if (!driverProfile) {
      try {
        driverProfile = await prisma.driver_profile.create({ data: { user_id } });
      } catch {
        driverProfile = await prisma.driver_profile.findFirst({ where: { user_id } });
      }
    }
    if (!driverProfile) return res.status(500).json({ error: 'Failed to resolve courier provider' });

    let ext = await prisma.driver_courier_profile.findUnique({ where: { driver_profile_id: driverProfile.driver_profile_id } });
    if (!ext) {
      try {
        ext = await prisma.driver_courier_profile.create({
          data: { driver_profile_id: driverProfile.driver_profile_id, display_name: req.user.name || 'Courier' },
        });
      } catch {
        ext = await prisma.driver_courier_profile.findUnique({ where: { driver_profile_id: driverProfile.driver_profile_id } });
      }
    }
    if (!ext) return res.status(500).json({ error: 'Failed to resolve courier provider' });

    const user = await prisma.user.findUnique({ where: { user_id } });
    res.json(flattenCourierProvider({ ...driverProfile, driver_courier_profile: ext, user, courier_order: [] }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to resolve courier provider' });
  }
});

/**
 * Get single courier service provider
 */
router.get('/:courier_service_provider_id', authenticateToken, async (req, res) => {
  try {
    const profile = await prisma.driver_profile.findFirst({
      where: { driver_profile_id: Number(req.params.courier_service_provider_id), driver_courier_profile: { isNot: null } },
      include: COURIER_INCLUDE,
    });

    if (!profile)
      return res.status(404).json({ error: 'Courier service provider not found' });

    res.json(flattenCourierProvider(profile));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch courier service provider' });
  }
});

/**
 * Create courier service provider (get-or-create the underlying driver_profile for
 * courier_service_provider_user_id, then attach a driver_courier_profile).
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { courier_service_provider_name, courier_service_provider_user_id, price_per_km } = req.body;

    if (!courier_service_provider_name || !courier_service_provider_user_id) {
      return res.status(400).json({ error: 'Name and user_id are required' });
    }

    const existingExt = await prisma.driver_courier_profile.findFirst({
      where: { driver_profile: { user_id: courier_service_provider_user_id } },
    });
    if (existingExt) {
      return res.status(409).json({ error: 'This user is already a registered courier provider' });
    }

    const driverProfile = await prisma.driver_profile.findFirst({ where: { user_id: courier_service_provider_user_id } })
      ?? await prisma.driver_profile.create({ data: { user_id: courier_service_provider_user_id } });

    const ext = await prisma.driver_courier_profile.create({
      data: {
        driver_profile_id: driverProfile.driver_profile_id,
        display_name: courier_service_provider_name,
        price_per_km,
      },
    });

    const newProvider = flattenCourierProvider({ ...driverProfile, driver_courier_profile: ext, user: null, courier_order: [] });

    io?.emit('courier-service-provider-created', newProvider);

    res.status(201).json(newProvider);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create courier service provider' });
  }
});

/**
 * Update courier service provider
 */
router.put('/:courier_service_provider_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { courier_service_provider_id } = req.params;
    const { courier_service_provider_name, courier_service_provider_user_id, price_per_km } = req.body;
    const driver_profile_id = Number(courier_service_provider_id);

    const existing = await prisma.driver_courier_profile.findUnique({ where: { driver_profile_id } });

    if (!existing)
      return res.status(404).json({ error: 'Courier service provider not found' });

    // user_id lives on the shared driver_profile — changing it affects every capability
    // this driver holds (rideshare/delivery too), not just courier.
    if (courier_service_provider_user_id !== undefined) {
      await prisma.driver_profile.update({ where: { driver_profile_id }, data: { user_id: courier_service_provider_user_id } });
    }

    const updatedExt = await prisma.driver_courier_profile.update({
      where: { driver_profile_id },
      data: {
        display_name: courier_service_provider_name,
        price_per_km,
      },
    });

    const driverProfile = await prisma.driver_profile.findUnique({ where: { driver_profile_id } });
    const updatedProvider = flattenCourierProvider({ ...driverProfile, driver_courier_profile: updatedExt, user: null, courier_order: [] });

    io?.emit('courier-service-provider-updated', updatedProvider);

    res.json(updatedProvider);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update courier service provider' });
  }
});

/**
 * Delete courier service provider — removes the courier capability (driver_courier_profile)
 * only. The underlying driver_profile is left intact since the same person may still hold
 * rideshare or delivery capabilities on it.
 */
router.delete('/:courier_service_provider_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const driver_profile_id = Number(req.params.courier_service_provider_id);
    await prisma.driver_courier_profile.delete({ where: { driver_profile_id } });

    io?.emit('courier-service-provider-deleted', { courier_service_provider_id: driver_profile_id });

    res.json({ message: 'Courier service provider deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete courier service provider' });
  }
});

export default router;
