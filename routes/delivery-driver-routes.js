import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { z } from 'zod';


const router = express.Router();
const driverStatusSchema = z.object({
  is_online: z.boolean(),
  current_lat: z.number().optional(),
  current_long: z.number().optional()
});

// Backed by driver_profile + driver_delivery_profile (unified driver identity). Presence
// (is_online/current_lat/current_long) now lives on driver_profile — one online status per
// driver, shared with rideshare/courier — driver_delivery_profile only holds vendor_type_id.
// Every response here still keeps the flat delivery_driver shape at the top level since
// Food.jsx and other callers read it that way.
const DRIVER_INCLUDE = { user: true, driver_delivery_profile: { include: { vendor_type: true } }, food_order: true };

function flattenDeliveryDriver(profile) {
  if (!profile) return null;
  const ext = profile.driver_delivery_profile;
  return {
    driver_id: profile.driver_profile_id,
    user_id: profile.user_id,
    current_lat: profile.current_lat ?? null,
    current_long: profile.current_long ?? null,
    is_online: profile.is_online ?? null,
    vendor_type_id: ext?.vendor_type_id ?? null,
    user: profile.user,
    vendor_type: ext?.vendor_type ?? null,
    food_order: profile.food_order,
  };
}

/**
 * Task D1: Toggle Delivery Driver Online/Offline
 * PATCH /delivery-driver/:driver_id/status
 * @deprecated superseded by PATCH /driver-profile/me/status (the single online switch shared
 * by every vertical) — kept only so any stale caller doesn't 404, not used by the frontend.
 */
router.patch('/:driver_id/status', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const driver_id = Number(req.params.driver_id);

    // 1. Validate Input
    const validated = driverStatusSchema.safeParse(req.body);
    if (!validated.success) return res.status(400).json({ successful: false, errors: (validated.error.issues ?? validated.error.errors) });

    const { is_online, current_lat, current_long } = validated.data;

    // 2. Update the shared driver_profile (driver_id is the canonical driver_profile_id)
    const updated = await prisma.driver_profile.update({
      where: { driver_profile_id: driver_id },
      data: {
        is_online,
        current_lat: current_lat ?? undefined,
        current_long: current_long ?? undefined,
      }
    });

    // 3. Real-time Notification (System update)
    io?.emit('delivery-driver-status-changed', {
      driver_id,
      is_online
    });

    return res.json({
      successful: true,
      message: is_online ? "You are now Online" : "You are now Offline",
      data: { driver_id, is_online: updated.is_online, current_lat: updated.current_lat, current_long: updated.current_long }
    });

  } catch (err) {
    console.error('Driver Status Error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * Task D6: Get Delivery Driver's Daily Earnings Summary
 * GET /delivery-driver/:driver_id/earnings/today
 */
router.get('/:driver_id/earnings/today', authenticateToken, async (req, res) => {
  try {
    const driver_id = Number(req.params.driver_id);

    // (Today's start and end)
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);


    const orders = await prisma.food_order.findMany({
      where: {
        driver_id: driver_id,
        order_status: 'delivered',
        delivered_at: {
          gte: today,
          lt: tomorrow
        }
      },
      select: {
        delivery_fee: true,
        driver_earning: true,
        order_flow: true,
        total_amount: true
      }
    });

    // Fetch delivered product orders too
    const productOrders = await prisma.product_order.findMany({
      where: {
        driver_id: driver_id,
        status: 'fulfilled',
        date: {
          gte: today,
          lt: tomorrow
        }
      },
      select: {
        delivery_fee: true,
        total: true
      }
    });

    // (Aggregation)
    const foodEarnings = orders.reduce((sum, order) => sum + (order.driver_earning ?? order.delivery_fee ?? 0), 0);
    const productEarnings = productOrders.reduce((sum, order) => sum + (order.delivery_fee || 0), 0);
    const totalEarnings = foodEarnings + productEarnings;
    const totalOrders = orders.length + productOrders.length;

    const foodOrderValue = orders.reduce((sum, order) => sum + (order.total_amount || 0), 0);
    const productOrderValue = productOrders.reduce((sum, order) => sum + (Number(order.total) || 0), 0);
    const totalOrderValue = foodOrderValue + productOrderValue;

    return res.json({
      successful: true,
      stats: {
        date: today.toISOString().split('T')[0],
        total_completed_deliveries: totalOrders,
        total_earnings: totalEarnings.toFixed(2),
        total_order_value_handled: totalOrderValue.toFixed(2),
        currency: "CAD"
      }
    });

  } catch (err) {
    console.error('Driver Earnings Error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});


function haversineKm(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const cDist = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * cDist;
}

/**
 * Get all delivery drivers
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { lat, long, radius_km } = req.query;
    const userLat = lat ? parseFloat(lat) : null;
    const userLong = long ? parseFloat(long) : null;
    const radius = radius_km ? parseFloat(radius_km) : 20;

    const profiles = await prisma.driver_profile.findMany({
      where: { driver_delivery_profile: { isNot: null } },
      orderBy: { driver_profile_id: 'asc' },
      include: DRIVER_INCLUDE,
    });

    let drivers = profiles.map(flattenDeliveryDriver);

    if (userLat !== null && userLong !== null) {
      drivers = drivers.filter(d => {
        if (d.current_lat == null || d.current_long == null) return true;
        const dist = haversineKm(userLat, userLong, d.current_lat, d.current_long);
        return dist !== null && dist <= radius;
      });
    }

    res.json(drivers);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch delivery drivers' });
  }
});

/**
 * GET /delivery-driver/me — get-or-create the caller's delivery capability (driver_profile +
 * driver_delivery_profile), mirroring GET /courier-service-provider/me. Used by the driver
 * onboarding step so turning on "Food"/"Shop" actually grants the capability row that
 * delivery-dispatch requires, not just the accepts_food/accepts_product preference flag.
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
    if (!driverProfile) return res.status(500).json({ error: 'Failed to resolve delivery driver' });

    let ext = await prisma.driver_delivery_profile.findUnique({ where: { driver_profile_id: driverProfile.driver_profile_id } });
    if (!ext) {
      try {
        ext = await prisma.driver_delivery_profile.create({
          data: { driver_profile_id: driverProfile.driver_profile_id },
        });
      } catch {
        ext = await prisma.driver_delivery_profile.findUnique({ where: { driver_profile_id: driverProfile.driver_profile_id } });
      }
    }
    if (!ext) return res.status(500).json({ error: 'Failed to resolve delivery driver' });

    const full = await prisma.driver_profile.findUnique({ where: { driver_profile_id: driverProfile.driver_profile_id }, include: DRIVER_INCLUDE });
    res.json(flattenDeliveryDriver(full));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to resolve delivery driver' });
  }
});

/**
 * Get single delivery driver
 */
router.get('/:driver_id', authenticateToken, async (req, res) => {
  try {
    const profile = await prisma.driver_profile.findFirst({
      where: { driver_profile_id: Number(req.params.driver_id), driver_delivery_profile: { isNot: null } },
      include: DRIVER_INCLUDE,
    });

    if (!profile)
      return res.status(404).json({ error: 'Delivery driver not found' });

    res.json(flattenDeliveryDriver(profile));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch delivery driver' });
  }
});

/**
 * Create delivery driver (get-or-create the underlying driver_profile for user_id,
 * then attach a driver_delivery_profile — the delivery capability marker).
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { user_id, current_lat, current_long, is_online, vendor_type_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    const existingExt = await prisma.driver_delivery_profile.findFirst({
      where: { driver_profile: { user_id } },
    });
    if (existingExt) {
      return res.status(409).json({ error: 'This user is already a registered delivery driver' });
    }

    let driverProfile = await prisma.driver_profile.findFirst({ where: { user_id } })
      ?? await prisma.driver_profile.create({ data: { user_id } });

    // Presence lives on the shared driver_profile now — only touch it if the caller actually
    // passed values, so this create doesn't silently flip a driver's existing online status.
    if (current_lat !== undefined || current_long !== undefined || is_online !== undefined) {
      driverProfile = await prisma.driver_profile.update({
        where: { driver_profile_id: driverProfile.driver_profile_id },
        data: {
          current_lat: current_lat ?? undefined,
          current_long: current_long ?? undefined,
          is_online: is_online ?? undefined,
        },
      });
    }

    const ext = await prisma.driver_delivery_profile.create({
      data: {
        driver_profile_id: driverProfile.driver_profile_id,
        vendor_type_id,
      },
    });

    const newDriver = flattenDeliveryDriver({ ...driverProfile, driver_delivery_profile: ext, user: null, food_order: [] });

    io?.emit('delivery-driver-created', newDriver);

    res.status(201).json(newDriver);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create delivery driver' });
  }
});

/**
 * Update delivery driver
 */
router.put('/:driver_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { driver_id } = req.params;
    const { user_id, current_lat, current_long, is_online, vendor_type_id } = req.body;
    const driver_profile_id = Number(driver_id);

    const existing = await prisma.driver_delivery_profile.findUnique({
      where: { driver_profile_id },
    });

    if (!existing)
      return res.status(404).json({ error: 'Delivery driver not found' });

    // user_id and presence live on the shared driver_profile — changing them affects every
    // capability this driver holds (rideshare/courier too), not just delivery.
    if (user_id !== undefined || current_lat !== undefined || current_long !== undefined || is_online !== undefined) {
      await prisma.driver_profile.update({
        where: { driver_profile_id },
        data: {
          user_id: user_id !== undefined ? user_id : undefined,
          current_lat: current_lat ?? undefined,
          current_long: current_long ?? undefined,
          is_online: is_online ?? undefined,
        },
      });
    }

    const updatedExt = await prisma.driver_delivery_profile.update({
      where: { driver_profile_id },
      data: { vendor_type_id },
    });

    const driverProfile = await prisma.driver_profile.findUnique({ where: { driver_profile_id } });
    const updatedDriver = flattenDeliveryDriver({ ...driverProfile, driver_delivery_profile: updatedExt, user: null, food_order: [] });

    io?.emit('delivery-driver-updated', updatedDriver);

    res.json(updatedDriver);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update delivery driver' });
  }
});

/**
 * Delete delivery driver — removes the delivery capability (driver_delivery_profile) only.
 * The underlying driver_profile is left intact since the same person may still hold
 * rideshare or courier capabilities on it.
 */
router.delete('/:driver_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const driver_profile_id = Number(req.params.driver_id);
    await prisma.driver_delivery_profile.delete({
      where: { driver_profile_id },
    });

    io?.emit('delivery-driver-deleted', { driver_id: driver_profile_id });

    res.json({ message: 'Delivery driver deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete delivery driver' });
  }
});

export default router;
