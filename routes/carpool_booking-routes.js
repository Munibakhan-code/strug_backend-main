import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { isAdmin } from '../middleware/require-admin.js';
import { sendEmail } from '../utils/mailer.js';
import { emailLngFromUser } from '../utils/email-lang.js';
import { decrypt } from '../utils/crypto.js';

const router = express.Router();

// The user_id of the driver who owns a carpool offer (offer → driver_profile → user), or null.
async function offerDriverUserId(offer_id) {
  const offer = await prisma.carpool_offer.findUnique({
    where: { carpool_offer_id: Number(offer_id) },
    select: { driver_profile: { select: { user_id: true } } },
  });
  return offer?.driver_profile?.user_id ?? null;
}

//======================================================================================================
// 1. GET MY BOOKING
//======================================================================================================
router.get('/me', authenticateToken, async (req, res) => {
  try {
    // NOTE: must be user_id (snake_case). req.user.userId is undefined, and a `where` with an
    // undefined value is dropped by Prisma — which returned EVERY user's bookings here.
    const passenger_id = req.user.user_id;

    const myBookings = await prisma.carpool_booking.findMany({
      where: { passenger_id: passenger_id },
      include: {
        carpool_offer: {
          include: {
            driver_profile: { include: { user: { select: { name: true } } } },
            vehicle: true,
            carpool_waypoints: true
          }
        }
      },
      orderBy: { booking_id: 'desc' }
    });

    return res.json({ successful: true, data: myBookings });
  } catch (err) {
    console.error('Error in /me:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

//======================================================================================================
// 2. GET BOOKINGS BY OFFER 
//======================================================================================================
router.get('/offer/:offer_id', authenticateToken, async (req, res) => {
  try {
    const offer_id = Number(req.params.offer_id);
    if (isNaN(offer_id)) return res.status(400).json({ error: 'Invalid Offer ID' });

    // Only the offer's own driver (or an admin) may see who booked their ride. Passenger email
    // is PII and is never returned in this manifest.
    if (!isAdmin(req) && (await offerDriverUserId(offer_id)) !== req.user.user_id) {
      return res.status(403).json({ successful: false, message: 'Forbidden' });
    }

    const bookings = await prisma.carpool_booking.findMany({
      where: { offer_id },
      include: { user: { select: { user_id: true, name: true } } }
    });
    res.json({ successful: true, data: bookings });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

//======================================================================================================
// 3. POST - CREATE BOOKING
//======================================================================================================
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { offer_id, seats_booked } = req.body;
        const passenger_id = req.user.user_id;
        const seats = Number(seats_booked);
        if (!Number.isInteger(seats) || seats <= 0) {
            return res.status(400).json({ successful: false, message: 'seats_booked must be a positive integer' });
        }

        const result = await prisma.$transaction(async (tx) => {
            const offer = await tx.carpool_offer.findUnique({ where: { carpool_offer_id: Number(offer_id) } });
            if (!offer) throw new Error('OFFER_NOT_FOUND');

            // Conditional atomic decrement — the seat-availability guard lives in the WHERE
            // clause, so two concurrent bookings can't both pass a stale read and oversell
            // the car into negative available_seats.
            const dec = await tx.carpool_offer.updateMany({
                where: { carpool_offer_id: Number(offer_id), available_seats: { gte: seats } },
                data: { available_seats: { decrement: seats } },
            });
            if (dec.count === 0) throw new Error('NOT_ENOUGH_SEATS');

            return await tx.carpool_booking.create({
                data: { offer_id: Number(offer_id), passenger_id, seats_booked: seats, total_cost: offer.price_per_seat * seats, status: 'confirmed' },
                include: { user: true, carpool_offer: true }
            });
        });

        if (result.user?.email) {
            const userCurrency = result.user.currency || "CAD";
            await sendEmail('carpool-booking', {
                seats_booked: result.seats_booked,
                total_cost: parseFloat(result.total_cost).toFixed(2),
                currency: userCurrency, 
                origin_city: result.carpool_offer.origin_city,
                destination_city: result.carpool_offer.destination_city
            }, decrypt(result.user.email), 'emails.carpool_booking.subject', emailLngFromUser(result.user));
        }

        res.status(201).json({ successful: true, message: "Booking confirmed!", data: result });
    } catch (err) {
        res.status(400).json({ successful: false, message: err.message });
    }
});


//======================================================================================================
// 4. GET SINGLE BOOKING BY ID 
//======================================================================================================
router.get('/:booking_id', authenticateToken, async (req, res) => {
  try {
    const booking_id = Number(req.params.booking_id);
    
   
    if (isNaN(booking_id)) {
        return res.status(400).json({ successful: false, message: 'Invalid ID format' });
    }

    const booking = await prisma.carpool_booking.findUnique({
      where: { booking_id },
      include: { carpool_offer: true, user: { select: { user_id: true, name: true } } }
    });

    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    // Only the passenger, the offer's driver, or an admin may read a booking.
    const driverUserId = booking.offer_id ? await offerDriverUserId(booking.offer_id) : null;
    if (!isAdmin(req) && booking.passenger_id !== req.user.user_id && driverUserId !== req.user.user_id) {
      return res.status(403).json({ successful: false, message: 'Forbidden' });
    }
    res.json({ successful: true, data: booking });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch booking' });
  }
});

export default router;
