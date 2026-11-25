import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

/** Rideshare passenger + driver vehicle classes (SSOT with ride-fare.js). */
const RIDESHARE_VEHICLE_TYPES = {
  economy: { base_rate_per_km: 0.85 },
  comfort: { base_rate_per_km: 1.10 },
  premium: { base_rate_per_km: 1.80 },
  suv: { base_rate_per_km: 1.40 },
  xl: { base_rate_per_km: 1.60 },
  accessible: { base_rate_per_km: 0.90 },
};

const RIDESHARE_TYPE_ORDER = [
  'economy',
  'comfort',
  'premium',
  'suv',
  'xl',
  'accessible',
];

/* GET rideshare vehicle type catalog — upserts missing rows */
router.get('/rideshare/catalog', async (_req, res) => {
  try {
    const rows = [];
    for (const name of RIDESHARE_TYPE_ORDER) {
      let vt = await prisma.vehicle_types.findFirst({ where: { name } });
      if (!vt) {
        vt = await prisma.vehicle_types.create({
          data: { name, ...RIDESHARE_VEHICLE_TYPES[name] },
        });
      }
      rows.push(vt);
    }
    return res.json({ successful: true, data: rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ successful: false, message: 'Failed to fetch rideshare vehicle types' });
  }
});

//======================================================================================================
//=============================================== CRUD =================================================
//======================================================================================================

/* GET ALL VEHICLE TYPES */
router.get('/', /*authenticateToken,*/ async (_req, res) => {
  try {
    const vehicleTypes = await prisma.vehicle_types.findMany({
      orderBy: { vehicle_type_id: 'desc' },
      include: {
        booking_type: true,
        vehicle: true,
        ride_request: true,
      },
    });

    res.json(vehicleTypes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch vehicle types' });
  }
});

/* GET VEHICLE TYPE BY ID */
router.get('/:vehicle_type_id', /*authenticateToken,*/ async (req, res) => {
  try {
    const vehicle_type_id = Number(req.params.vehicle_type_id);

    if (Number.isNaN(vehicle_type_id)) {
      return res.status(400).json({ error: 'vehicle_type_id must be a number' });
    }

    const vehicleType = await prisma.vehicle_types.findUnique({
      where: { vehicle_type_id },
      include: {
        booking_type: true,
        vehicle: true,
        ride_request: true,
      },
    });

    if (!vehicleType) {
      return res.status(404).json({ error: 'Vehicle type not found' });
    }

    res.json(vehicleType);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch vehicle type' });
  }
});

/* CREATE VEHICLE TYPE */
router.post('/', /*authenticateToken,*/ async (req, res) => {
  try {
    const { name, base_rate_per_km, booking_type_id } = req.body;

    const vehicleType = await prisma.vehicle_types.create({
      data: {
        name,
        base_rate_per_km,
        booking_type_id,
      },
      include: {
        booking_type: true,
      },
    });

    res.status(201).json(vehicleType);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create vehicle type' });
  }
});

/* UPDATE VEHICLE TYPE */
router.put('/:vehicle_type_id', /*authenticateToken,*/ async (req, res) => {
  try {
    const vehicle_type_id = Number(req.params.vehicle_type_id);

    if (Number.isNaN(vehicle_type_id)) {
      return res.status(400).json({ error: 'vehicle_type_id must be a number' });
    }

    const { name, base_rate_per_km, booking_type_id } = req.body;

    const existing = await prisma.vehicle_types.findUnique({
      where: { vehicle_type_id },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Vehicle type not found' });
    }

    const updated = await prisma.vehicle_types.update({
      where: { vehicle_type_id },
      data: {
        name: name ?? existing.name,
        base_rate_per_km: base_rate_per_km ?? existing.base_rate_per_km,
        booking_type_id: booking_type_id ?? existing.booking_type_id,
      },
      include: {
        booking_type: true,
        vehicle: true,
        ride_request: true,
      },
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update vehicle type' });
  }
});

/* DELETE VEHICLE TYPE */
router.delete('/:vehicle_type_id', /*authenticateToken,*/ async (req, res) => {
  try {
    const vehicle_type_id = Number(req.params.vehicle_type_id);

    if (Number.isNaN(vehicle_type_id)) {
      return res.status(400).json({ error: 'vehicle_type_id must be a number' });
    }

    await prisma.vehicle_types.delete({
      where: { vehicle_type_id },
    });

    res.json({ message: 'Vehicle type deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete vehicle type' });
  }
});

//======================================================================================================
//=============================================== END CRUD =============================================
//======================================================================================================

export default router;
