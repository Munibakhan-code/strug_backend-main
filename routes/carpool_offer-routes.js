// routes/carpoolOffer.js
import express from 'express';
import prisma from './../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { z } from 'zod';

const router = express.Router();

const carpoolOfferSchema = z.object({
  vehicle_id: z.number().int(),
  origin_city: z.string(),
  destination_city: z.string(),
  departure_time: z.string(),
  price_per_seat: z.number(),
  total_seats: z.number().int().min(1),
  allow_smoking: z.boolean().optional(),
  allow_pets: z.boolean().optional(),
});


/**
 * Task 06: Search Carpool Offers (Production Ready)
 * GET /carpool-offer/search?from=Colombo&to=Galle&date=2026-05-10
 */
router.get('/search', authenticateToken, async (req, res) => {
  try {
    const { from, to, date } = req.query;

    if (!from || !to) {
      return res.status(400).json({ successful: false, message: "Origin and Destination are required." });
    }

  
    const filters = {
      available_seats: { gt: 0 }, 
      OR: [
        {
     
          origin_city: { contains: from, mode: 'insensitive' },
          destination_city: { contains: to, mode: 'insensitive' }
        },
        {
   
          carpool_waypoints: {
            some: {
              city_name: { contains: from, mode: 'insensitive' }
            }
          }
        }
      ]
    };

   
    if (date) {
      const searchDate = new Date(date);
      const nextDay = new Date(searchDate);
      nextDay.setDate(searchDate.getDate() + 1);

      filters.departure_time = {
        gte: searchDate,
        lt: nextDay
      };
    }

    // (Corrected Include/Select Logic)
    const offers = await prisma.carpool_offer.findMany({
      where: filters,
      include: {
        driver_profile: {
          select: {
            rating: true, 
            user: {
              select: {
                name: true 
              }
            }
          }
        },
        vehicle: {
          select: {
            model: true,
            plate_number: true,
            color: true
          }
        },
        carpool_waypoints: {
          orderBy: { arrival_time_est: 'asc' }
        }
      },
      orderBy: { departure_time: 'asc' }
    });

    return res.json({ 
      successful: true, 
      count: offers.length,
      data: offers 
    });

  } catch (err) {
    console.error('Search Error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error during search' });
  }
});

/**
 * Get all carpool offers
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const offers = await prisma.carpool_offer.findMany({
      orderBy: { carpool_offer_id: 'desc' },
      include: {
        driver_profile: true,
        vehicle: true,
      },
    });

    res.json(offers);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch carpool offers' });
  }
});

/**
 * Get single carpool offer
 */
router.get('/:carpool_offer_id', authenticateToken, async (req, res) => {
  try {
    const offer = await prisma.carpool_offer.findUnique({
      where: { carpool_offer_id: Number(req.params.carpool_offer_id) },
      include: {
        driver_profile: true,
        vehicle: true,
      },
    });

    if (!offer) return res.status(404).json({ error: 'Carpool offer not found' });

    res.json(offer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch carpool offer' });
  }
});

/**
 * Create new carpool offer
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    // 1. Validation
    const validated = carpoolOfferSchema.safeParse(req.body);
    if (!validated.success) return res.status(400).json({ successful: false, errors: (validated.error.issues ?? validated.error.errors) });

    const { vehicle_id, origin_city, destination_city, departure_time, price_per_seat, total_seats, allow_smoking, allow_pets } = validated.data;

    // 2. Driver Verification: 
    const driver = await prisma.driver_profile.findFirst({
      where: { user_id: req.user.userId }
    });

    if (!driver) {
      return res.status(403).json({ successful: false, message: "You need a Driver Profile to offer a carpool." });
    }

    // 3. Create Offer
    const newOffer = await prisma.carpool_offer.create({
      data: {
        driver_id: driver.driver_profile_id, 
        vehicle_id: Number(vehicle_id),
        origin_city,
        destination_city,
        departure_time: new Date(departure_time),
        price_per_seat: Number(price_per_seat),
        total_seats: Number(total_seats),
        available_seats: Number(total_seats), 
        allow_smoking: allow_smoking ?? false,
        allow_pets: allow_pets ?? false,
      },
    });

    io?.emit('carpool-offer-created', newOffer);
    res.status(201).json({ successful: true, data: newOffer });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create carpool offer' });
  }
});

/**
 * Update carpool offer
 */
router.put('/:carpool_offer_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { carpool_offer_id } = req.params;
    const {
      driver_id,
      vehicle_id,
      origin_city,
      destination_city,
      departure_time,
      price_per_seat,
      total_seats,
      available_seats,
      allow_smoking,
      allow_pets,
    } = req.body;

    const existing = await prisma.carpool_offer.findUnique({
      where: { carpool_offer_id: Number(carpool_offer_id) },
    });

    if (!existing) return res.status(404).json({ error: 'Carpool offer not found' });

    const updatedOffer = await prisma.carpool_offer.update({
      where: { carpool_offer_id: Number(carpool_offer_id) },
      data: {
        driver_id: driver_id ? Number(driver_id) : existing.driver_id,
        vehicle_id: vehicle_id ? Number(vehicle_id) : existing.vehicle_id,
        origin_city: origin_city ?? existing.origin_city,
        destination_city: destination_city ?? existing.destination_city,
        departure_time: departure_time ? new Date(departure_time) : existing.departure_time,
        price_per_seat: price_per_seat != null ? Number(price_per_seat) : existing.price_per_seat,
        total_seats: total_seats ? Number(total_seats) : existing.total_seats,
        available_seats: available_seats ? Number(available_seats) : existing.available_seats,
        allow_smoking: allow_smoking ?? existing.allow_smoking,
        allow_pets: allow_pets ?? existing.allow_pets,
      },
    });

    io?.emit('carpool-offer-updated', updatedOffer);

    res.json(updatedOffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update carpool offer' });
  }
});

/**
 * Delete carpool offer
 */
router.delete('/:carpool_offer_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const deleted = await prisma.carpool_offer.delete({
      where: { carpool_offer_id: Number(req.params.carpool_offer_id) },
    });

    io?.emit('carpool-offer-deleted', { carpool_offer_id: deleted.carpool_offer_id });

    res.json({ message: 'Carpool offer deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete carpool offer' });
  }
});

export default router;
