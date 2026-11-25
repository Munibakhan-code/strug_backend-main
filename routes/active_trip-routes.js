// routes/activeTrip.js
import express from 'express';
import prisma from './../utils/prisma-client.js';
import { clientErrorMessage } from '../utils/client-error.js';
import { authenticateToken } from '../middleware/authentication.js';
import { decrypt } from "../utils/crypto.js";
import { sendEmail } from '../utils/mailer.js';
import { emailLngFromUser } from '../utils/email-lang.js';
import { notifyOfferClosedToDrivers } from '../utils/ride-dispatch.js';
import {
  requireAuthUserId,
  assertTripAssignedToUser,
  assertDriverProfileOwnedByUser,
  resolveDriverProfileForUser,
  assertCanReadTrip,
  activeTripReadFilterForUser,
} from '../utils/ride-auth.js';
import {
  assertCanCompleteTrip,
  normalizeRideStatus,
  RIDE_STATUS,
  verifyTripOtpAndStart,
} from '../utils/ride-state-machine.js';
import { emitTripEnded } from '../utils/trip-socket.js';
import { resolveTripDistanceKm } from '../utils/ride-fare.js';
import { computeRideSettlement, creditDriverRidePayout } from '../utils/ride-settlement.js';
import { creditRecruiterShares } from '../utils/recruiter-share.js';
import { settleReferralThenRecruit } from '../utils/referral-settlement.js';
import { sanitizeActiveTripForDriver, stripInternalSettlementFields } from '../utils/ride-driver-view.js';
import { buildRideReceiptEmailVars, buildRideReceiptPayload } from '../utils/ride-receipt.js';
import {
  loadPassengerUserForRide,
  RIDE_STATUS_EMAIL_EVENT,
  sendPassengerRideStatusEmail,
} from '../utils/ride-status-email.js';
import { notifyRider } from '../utils/ride-rider-notify.js';

const router = express.Router();

/**
 * Driver marks as Arrived at Pickup point
 * PATCH /active-trip/:trip_id/arrived
 */
router.patch('/:trip_id/arrived', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const trip_id = Number(req.params.trip_id);

    // 1. Trip
    const trip = await prisma.active_trip.findUnique({
      where: { trip_id },
      include: {
        ride_request: true,
        vehicle: { include: { vehicle_types: true } },
        driver_profile: { include: { user: true, vehicle: { include: { vehicle_types: true } } } },
      },
    });

    if (!trip) return res.status(404).json({ successful: false, message: 'Trip not found' });

    const userId = requireAuthUserId(req, res);
    if (!userId) return;
    const denied = await assertTripAssignedToUser(prisma, trip, userId);
    if (denied) return res.status(denied.status).json({ successful: false, message: denied.message });

    const rideStatus = normalizeRideStatus(trip.ride_request?.status);
    if (rideStatus === RIDE_STATUS.CANCELLED || rideStatus === RIDE_STATUS.COMPLETED) {
      return res.status(400).json({ successful: false, message: 'Cannot update arrival for a finished ride' });
    }
    if (trip.ended_at) {
      return res.status(400).json({ successful: false, message: 'Trip is already completed' });
    }

    const arrivedAt = trip.driver_arrived_at ?? new Date();
    // Atomic first-arrival claim: only the request that flips driver_arrived_at from
    // null wins (count===1), so concurrent /arrived taps can't double-send the email.
    const claimedFirstArrival = !trip.driver_arrived_at
      ? (await prisma.active_trip.updateMany({
          where: { trip_id, driver_arrived_at: null },
          data: { driver_arrived_at: arrivedAt },
        })).count === 1
      : false;
    if (claimedFirstArrival) {
      try {
        const passenger = await loadPassengerUserForRide(prisma, trip.ride_request?.passenger_id);
        // Prefer the vehicle actually assigned to this trip; fall back to the driver's first vehicle.
        const vehicle = trip.vehicle ?? trip.driver_profile?.vehicle?.[0] ?? null;
        const vehicleType = vehicle?.vehicle_types?.name ?? vehicle?.model ?? 'Vehicle';
        await sendPassengerRideStatusEmail(RIDE_STATUS_EMAIL_EVENT.ARRIVED, {
          passengerUser: passenger,
          ride: trip.ride_request,
          trip,
          driverName: trip.driver_profile?.user?.name ?? 'Your driver',
          vehicleType,
          plate: vehicle?.plate_number ?? '—',
        });
      } catch (emailErr) {
        console.error('[arrived] status email failed:', emailErr.message);
      }
    }

    io.to(`user-${trip.ride_request?.passenger_id}`).emit(`driver-arrived-${trip.request_id}`, {
      message: "Your driver has arrived at the pickup location!",
      trip_id: trip_id,
      arrived_at: arrivedAt,
    });

    // Only on the first arrival — repeat taps re-emit the socket event (harmless for the live
    // screen) but must not spawn a second bell row / push.
    if (claimedFirstArrival) {
      const vehicle = trip.vehicle ?? trip.driver_profile?.vehicle?.[0] ?? null;
      notifyRider(io, 'driver_arrived', {
        passengerId: trip.ride_request?.passenger_id,
        actorUserId: trip.driver_profile?.user?.user_id ?? null,
        rideRequestId: trip.request_id,
        tripId: trip_id,
        body: 'Head to the pickup point — your driver is waiting.',
        data: {
          driver_name: trip.driver_profile?.user?.name ?? null,
          plate: vehicle?.plate_number ?? null,
        },
      });
    }

    return res.json({
      successful: true,
      message: 'Passenger notified of your arrival',
      already_arrived: !!trip.driver_arrived_at,
      driver_arrived_at: arrivedAt,
    });

  } catch (err) {
    console.error('Arrived Route Error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * Verify OTP to start trip (canonical).
 * PATCH /active-trip/:trip_id/verify-otp
 */
router.patch('/:trip_id/verify-otp', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const trip_id = Number(req.params.trip_id);
    const { otp } = req.body;
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const result = await verifyTripOtpAndStart(prisma, io, trip_id, otp, userId);
    if (result.error) {
      return res.status(result.error.status).json({ successful: false, message: result.error.message });
    }
    return res.json({
      successful: true,
      message: result.message,
      already_started: !!result.alreadyStarted,
    });
  } catch (err) {
    console.error('OTP Verification Error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});



router.patch('/:trip_id/status', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const trip_id = Number(req.params.trip_id);
    const { status } = req.body;

    const validStatuses = ['arrived', 'ongoing', 'completed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ successful: false, message: 'Invalid status' });
    }

    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const updatedTrip = await prisma.$transaction(async (tx) => {
      const existingTrip = await tx.active_trip.findUnique({
        where: { trip_id },
        include: { ride_request: true },
      });

      if (!existingTrip) {
        throw new Error('TRIP_NOT_FOUND');
      }

      const denied = await assertTripAssignedToUser(tx, existingTrip, userId);
      if (denied) {
        throw new Error('UNAUTHORIZED');
      }

      if (existingTrip.ended_at) {
        throw new Error('TRIP_ALREADY_COMPLETED');
      }

      const rideStatus = normalizeRideStatus(existingTrip.ride_request?.status);
      if (rideStatus === RIDE_STATUS.CANCELLED || rideStatus === RIDE_STATUS.COMPLETED) {
        throw new Error('RIDE_FINISHED');
      }

      if (status === 'completed') {
        throw new Error('USE_COMPLETE_ENDPOINT');
      }

      return existingTrip;
    });

    //  Notification
    io.to(`user-${updatedTrip.ride_request?.passenger_id}`).emit(`trip-status-changed-${updatedTrip.request_id}`, {
      trip_id,
      status
    });

    return res.json({ successful: true, status });

  } catch (err) {
    console.error('Update Status Error:', err);

    // Custom Error Handling
    if (err.message === 'TRIP_NOT_FOUND') {
      return res.status(404).json({ successful: false, message: 'Trip not found' });
    }
    if (err.message === 'UNAUTHORIZED') {
      return res.status(403).json({ successful: false, message: 'Unauthorized action' });
    }
    if (err.message === 'TRIP_ALREADY_COMPLETED') {
      return res.status(400).json({ successful: false, message: 'Trip is already completed' });
    }
    if (err.message === 'RIDE_FINISHED') {
      return res.status(400).json({ successful: false, message: 'Cannot update a finished ride' });
    }
    if (err.message === 'USE_COMPLETE_ENDPOINT') {
      return res.status(400).json({ successful: false, message: 'Use PATCH /active-trip/:trip_id/complete to end the trip' });
    }

    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * Get all active trips
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const trips = await prisma.active_trip.findMany({
      where: await activeTripReadFilterForUser(prisma, userId),
      orderBy: { trip_id: 'desc' },
      include: {
        driver_profile: true,
        ride_request: { include: { user: true } },
        vehicle: true,
      },
    });

    const driverProfiles = await prisma.driver_profile.findMany({
      where: { user_id: userId },
      select: { driver_profile_id: true },
    });
    const driverIds = new Set(driverProfiles.map((p) => p.driver_profile_id));

    res.json(
      trips.map((trip) =>
        driverIds.has(trip.driver_id) ? sanitizeActiveTripForDriver(trip) : trip,
      ),
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch active trips' });
  }
});

/**
 * Get single active trip by trip_id
 */
router.get('/:trip_id', authenticateToken, async (req, res) => {
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const trip = await prisma.active_trip.findUnique({
      where: { trip_id: Number(req.params.trip_id) },
      include: {
        driver_profile: true,
        ride_request: true,
        vehicle: true,
      },
    });

    const denied = await assertCanReadTrip(prisma, trip, userId);
    if (denied) {
      return res.status(denied.status).json({ successful: false, message: denied.message });
    }

    const asDriverDenied = await assertTripAssignedToUser(prisma, trip, userId);
    res.json(asDriverDenied ? trip : sanitizeActiveTripForDriver(trip));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch active trip' });
  }
});

/**
 * Create new active trip
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const {
      request_id,
      driver_id,
      vehicle_id,
      started_at,
      ended_at,
      actual_distance_km,
      total_fare,
      payment_method,
    } = req.body;

    // Basic validation - you can expand this
    if (!request_id || !driver_id || !vehicle_id) {
      return res.status(400).json({ error: 'request_id, driver_id, and vehicle_id are required' });
    }

    const userId = requireAuthUserId(req, res);
    if (!userId) return;
    const driverProfile = await resolveDriverProfileForUser(prisma, userId, driver_id);
    const denied = assertDriverProfileOwnedByUser(driverProfile, userId);
    if (denied || !driverProfile || driverProfile.driver_profile_id !== Number(driver_id)) {
      return res.status(403).json({ successful: false, message: 'Unauthorized action' });
    }

    const newTrip = await prisma.active_trip.create({
      data: {
        request_id: Number(request_id),
        driver_id: Number(driver_id),
        vehicle_id: Number(vehicle_id),
        started_at: started_at ? new Date(started_at) : null,
        ended_at: ended_at ? new Date(ended_at) : null,
        actual_distance_km,
        total_fare,
        payment_method,
      },
    });

    io?.emit('active-trip-created', stripInternalSettlementFields(newTrip));

    res.status(201).json(newTrip);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create active trip' });
  }
});

/**
 * Update active trip
 */


router.put('/:trip_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const { trip_id } = req.params;
    const {
      request_id,
      driver_id,
      vehicle_id,
      started_at,
      ended_at,
      actual_distance_km,
      total_fare,
      payment_method,
    } = req.body;

    const existing = await prisma.active_trip.findUnique({
      where: { trip_id: Number(trip_id) },
    });

    if (!existing) return res.status(404).json({ error: 'Active trip not found' });

    const userId = requireAuthUserId(req, res);
    if (!userId) return;
    const denied = await assertTripAssignedToUser(prisma, existing, userId);
    if (denied) return res.status(denied.status).json({ successful: false, message: denied.message });

    if (existing.ended_at) {
      return res.status(400).json({ successful: false, message: 'Cannot modify a completed trip' });
    }

    const updatedTrip = await prisma.active_trip.update({
      where: { trip_id: Number(trip_id) },
      data: {
        request_id: request_id ? Number(request_id) : existing.request_id,
        driver_id: existing.driver_id,
        vehicle_id: vehicle_id ? Number(vehicle_id) : existing.vehicle_id,
        started_at: started_at ? new Date(started_at) : existing.started_at,
        actual_distance_km: actual_distance_km ?? existing.actual_distance_km,
        total_fare: total_fare ?? existing.total_fare,
        payment_method: payment_method ?? existing.payment_method,
      },
    });

    io?.emit('active-trip-updated', stripInternalSettlementFields(updatedTrip));

    // PUT is driver-only (assertTripAssignedToUser above) — earnings only, no gross/fee.
    res.json(sanitizeActiveTripForDriver(updatedTrip));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update active trip' });
  }
});




router.patch('/:trip_id/complete', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const trip_id = Number(req.params.trip_id);
    const existing = await prisma.active_trip.findUnique({
      where: { trip_id },
      include: {
        ride_request: { include: { user: true } },
        driver_profile: { include: { user: true } },
      },
    });
    if (!existing) {
      return res.status(404).json({ successful: false, message: 'Trip not found' });
    }

    const userId = requireAuthUserId(req, res);
    if (!userId) return;
    const denied = await assertTripAssignedToUser(prisma, existing, userId);
    if (denied) return res.status(denied.status).json({ successful: false, message: denied.message });

    if (existing.ended_at) {
      return res.json({
        successful: true,
        message: 'Trip already completed',
        already_completed: true,
      });
    }

    const completeErr = assertCanCompleteTrip(existing.ride_request, existing);
    if (completeErr) {
      return res.status(completeErr.status).json({ successful: false, message: completeErr.message });
    }

    const bodyDistance = req.body.actual_distance_km;
    let actual_distance_km =
      bodyDistance != null && bodyDistance !== '' && !Number.isNaN(parseFloat(bodyDistance))
        ? parseFloat(bodyDistance)
        : existing.actual_distance_km ?? null;
    if (actual_distance_km == null) {
      const routeKm = await resolveTripDistanceKm(existing.ride_request);
      if (routeKm != null && routeKm > 0) {
        actual_distance_km = routeKm;
      }
    }
    // total_fare is authoritative from the server — it's what the rider was actually
    // charged at booking (set at accept from offered_fare ?? estimated_fare). The driver
    // must not be able to post an arbitrary fare onto the recorded trip / emailed receipt.
    const total_fare =
      existing.total_fare ?? existing.ride_request?.offered_fare ?? existing.ride_request?.estimated_fare ?? null;

    const settlement = computeRideSettlement(total_fare);
    const driverUserId = existing.driver_profile?.user_id ?? null;

    const rideStatus = normalizeRideStatus(existing.ride_request?.status);
    if (rideStatus === RIDE_STATUS.COMPLETED) {
      return res.json({
        successful: true,
        message: 'Trip already completed',
        already_completed: true,
      });
    }

    let alreadyCompleted = false;
    const result = await prisma.$transaction(async (tx) => {
      const tripInclude = {
        ride_request: { include: { user: true, vehicle_types: true } },
        driver_profile: {
          include: {
            user: true,
            vehicle: { include: { vehicle_types: true } },
          },
        },
        vehicle: { include: { vehicle_types: true } },
      };

      // Atomic close: only the request that flips ended_at from null wins. A concurrent
      // duplicate /complete blocks on this row lock, then matches 0 rows and bails — so the
      // driver payout below can never be credited twice for the same trip.
      const closed = await tx.active_trip.updateMany({
        where: { trip_id, ended_at: null },
        data: {
          ended_at: new Date(),
          share_token: null,
          share_token_created_at: null,
          ...(actual_distance_km != null ? { actual_distance_km } : {}),
          ...(settlement.total_fare != null ? { total_fare: settlement.total_fare } : {}),
          ...(settlement.driver_payout != null ? { driver_payout: settlement.driver_payout } : {}),
          ...(settlement.platform_fee != null ? { platform_fee: settlement.platform_fee } : {}),
          ...(['wallet', 'card', 'cash', 'paypal'].includes(req.body.payment_method) ? { payment_method: req.body.payment_method } : {}),
        },
      });
      if (closed.count === 0) {
        alreadyCompleted = true;
        return tx.active_trip.findUnique({ where: { trip_id }, include: tripInclude });
      }

      if (existing.request_id) {
        await tx.ride_request.update({
          where: { ride_request_id: existing.request_id },
          data: {
            status: RIDE_STATUS.COMPLETED,
            assigned_driver_id: null,
            offer_expires_at: null,
          },
        });
      }

      if (settlement.driver_payout != null) {
        await creditDriverRidePayout(tx, {
          tripId: trip_id,
          driverUserId,
          driverPayout: settlement.driver_payout,
        });
      }

      // Referral (passenger friend code) then Recruit (driver receive-side), shared platform-take budget.
      await settleReferralThenRecruit({
        referralCode: existing.ride_request?.referral_code,
        buyerUserId: existing.ride_request?.passenger_id,
        recruitParticipantUserIds: [driverUserId],
        subtotal: settlement.total_fare,
        platformTake: settlement.platform_fee,
        orderType: 'ride',
        orderRef: trip_id,
        creditRecruiterShares,
        tx,
      });

      return tx.active_trip.findUnique({ where: { trip_id }, include: tripInclude });
    });

    if (alreadyCompleted) {
      return res.json({
        successful: true,
        message: 'Trip already completed',
        already_completed: true,
      });
    }

    if (existing.request_id) {
      await notifyOfferClosedToDrivers(io, existing.request_id);
      const completedPayload = {
        trip_id,
        message: 'Your ride is complete.',
        status: RIDE_STATUS.COMPLETED,
      };
      const passengerId = existing.ride_request?.passenger_id;
      if (passengerId) {
        io?.to(`user-${passengerId}`).emit(`ride-completed-${existing.request_id}`, completedPayload);
        const fare = settlement?.total_fare ?? total_fare;
        notifyRider(io, 'completed', {
          passengerId,
          actorUserId: existing.driver_profile?.user_id ?? null,
          rideRequestId: existing.request_id,
          tripId: trip_id,
          body: fare != null
            ? `$${Number(fare).toFixed(2)} · your receipt is ready.`
            : 'Your receipt is ready.',
          data: { total_fare: fare ?? null, currency: existing.ride_request?.user?.currency ?? 'CAD' },
        });
      }
      emitTripEnded(io, trip_id, 'completed');
    }

    if (result.ride_request?.user) {
      try {
        const plainEmail = decrypt(result.ride_request.user.email);
        const userCurrency = result.ride_request.user.currency || 'CAD';
        const receipt = buildRideReceiptPayload(result.ride_request, result, { currency: userCurrency });
        if (receipt?.total_fare != null) {
          await sendEmail(
            'ride-receipt',
            buildRideReceiptEmailVars(receipt),
            plainEmail,
            'emails.subjects.ride_receipt',
            emailLngFromUser(result.ride_request.user),
          );
        }
      } catch (emailErr) {
        console.error('[complete trip] receipt email failed:', emailErr.message);
      }
    }

    res.json({
      successful: true,
      message: 'Trip completed and receipt sent',
      earnings: settlement.driver_payout,
    });
  } catch (err) {
    console.error('[complete trip]', err);
    res.status(500).json({ successful: false, message: clientErrorMessage(err) });
  }
});


/**
 * Delete active trip
 */
router.delete('/:trip_id', authenticateToken, async (req, res) => {
  const io = req.app.get('io');

  try {
    const trip_id = Number(req.params.trip_id);
    const existing = await prisma.active_trip.findUnique({ where: { trip_id } });
    if (!existing) return res.status(404).json({ error: 'Active trip not found' });

    const userId = requireAuthUserId(req, res);
    if (!userId) return;
    const denied = await assertTripAssignedToUser(prisma, existing, userId);
    if (denied) return res.status(denied.status).json({ successful: false, message: denied.message });

    if (existing.ended_at) {
      return res.status(400).json({ successful: false, message: 'Cannot delete a completed trip' });
    }

    const deleted = await prisma.active_trip.delete({
      where: { trip_id },
    });

    io?.emit('active-trip-deleted', { trip_id: deleted.trip_id });

    res.json({ message: 'Active trip deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete active trip' });
  }
});

export default router;
