// routes/carpoolWaypoints.js
import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { z } from 'zod';

const router = express.Router();
const waypointSchema = z.object({
  offer_id: z.number().int(),
  city_name: z.string().min(2),
  arrival_time_est: z.string().optional(), 
  pickup_allowed: z.boolean().default(true),
});





/**
 * Get all carpool waypoints
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const waypoints = await prisma.carpool_waypoints.findMany({
      orderBy: { waypoint_id: 'asc' },
      include: {
        carpool_offer: true,
      },
    });

    res.json(waypoints);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch carpool waypoints' });
  }
});

/**
 * Get single carpool waypoint
 */
router.get('/:waypoint_id', authenticateToken, async (req, res) => {
  try {
    const waypoint = await prisma.carpool_waypoints.findUnique({
      where: { waypoint_id: Number(req.params.waypoint_id) },
      include: {
        carpool_offer: true,
      },
    });

    if (!waypoint) return res.status(404).json({ error: 'Carpool waypoint not found' });

    res.json(waypoint);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch carpool waypoint' });
  }
});

/**
 * Task 02: Add a waypoint to an existing Carpool Offer
 * POST /carpool-waypoints
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    // 1. Validation
    const validated = waypointSchema.safeParse(req.body);
    if (!validated.success) return res.status(400).json({ successful: false, errors: (validated.error.issues ?? validated.error.errors) });

    const { offer_id, city_name, arrival_time_est, pickup_allowed } = validated.data;

    // 2. Ownership Check
    const offer = await prisma.carpool_offer.findUnique({
      where: { carpool_offer_id: offer_id },
      include: { driver_profile: true }
    });

    if (!offer) return res.status(404).json({ successful: false, message: "Offer not found." });

    // Driver verification 
    const driver = await prisma.driver_profile.findFirst({ where: { user_id: req.user.userId } });
    if (!driver || offer.driver_id !== driver.driver_profile_id) {
      return res.status(403).json({ successful: false, message: "Unauthorized: You don't own this offer." });
    }

    // 3. Create Waypoint
    const newWaypoint = await prisma.carpool_waypoints.create({
      data: {
        offer_id: offer_id,
        city_name,
        arrival_time_est: arrival_time_est ? new Date(arrival_time_est) : null,
        pickup_allowed
      },
    });

    io?.emit('waypoint-added', newWaypoint);
    return res.status(201).json({ successful: true, data: newWaypoint });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to add waypoint' });
  }
});

/**
 * Update carpool waypoint
 */
router.put('/:waypoint_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { waypoint_id } = req.params;
    const {
      offer_id,
      city_name,
      arrival_time_est,
      pickup_allowed,
    } = req.body;

    const existing = await prisma.carpool_waypoints.findUnique({
      where: { waypoint_id: Number(waypoint_id) },
    });

    if (!existing) return res.status(404).json({ error: 'Carpool waypoint not found' });

    const updatedWaypoint = await prisma.carpool_waypoints.update({
      where: { waypoint_id: Number(waypoint_id) },
      data: {
        offer_id: offer_id ? Number(offer_id) : existing.offer_id,
        city_name: city_name ?? existing.city_name,
        arrival_time_est: arrival_time_est ? new Date(arrival_time_est) : existing.arrival_time_est,
        pickup_allowed: pickup_allowed ?? existing.pickup_allowed,
      },
    });

    io?.emit('carpool-waypoint-updated', updatedWaypoint);

    res.json(updatedWaypoint);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update carpool waypoint' });
  }
});

/**
 * Delete carpool waypoint
 */
router.delete('/:waypoint_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const deleted = await prisma.carpool_waypoints.delete({
      where: { waypoint_id: Number(req.params.waypoint_id) },
    });

    io?.emit('carpool-waypoint-deleted', { waypoint_id: deleted.waypoint_id });

    res.json({ message: 'Carpool waypoint deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete carpool waypoint' });
  }
});

export default router;
