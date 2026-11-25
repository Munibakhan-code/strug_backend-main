import {
  assertTripAssignedToUser,
} from './ride-auth.js';
import { notifyRider } from './ride-rider-notify.js';

export const RIDE_STATUS = {
  SCHEDULED: 'scheduled',
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  ONGOING: 'ongoing',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
};

const TERMINAL_RIDE = new Set([RIDE_STATUS.COMPLETED, RIDE_STATUS.CANCELLED]);

export function normalizeRideStatus(status) {
  return (status || '').toLowerCase();
}

/** HTTP error payload for invalid ride_request status transitions. */
export function rideTransitionError(status, action) {
  const s = normalizeRideStatus(status);
  if (s === RIDE_STATUS.CANCELLED) {
    return { status: 409, message: `Cannot ${action} — ride was cancelled.` };
  }
  if (s === RIDE_STATUS.COMPLETED) {
    return { status: 409, message: `Cannot ${action} — ride is already completed.` };
  }
  if (s === RIDE_STATUS.ACCEPTED || s === RIDE_STATUS.ONGOING) {
    return { status: 409, message: `Cannot ${action} — ride is already ${s}.` };
  }
  return { status: 400, message: `Cannot ${action} in current ride state.` };
}

export function assertCanAcceptRide(ride) {
  if (!ride) return { status: 404, message: 'Ride not found' };
  const s = normalizeRideStatus(ride.status);
  if (s === RIDE_STATUS.PENDING) return null;
  return rideTransitionError(ride.status, 'accept');
}

export function assertCanCancelRide(ride) {
  if (!ride) return { status: 404, message: 'Ride request not found' };
  const s = normalizeRideStatus(ride.status);
  if (s === RIDE_STATUS.CANCELLED) {
    return { status: 400, message: 'Ride is already cancelled' };
  }
  if (s === RIDE_STATUS.ONGOING || s === RIDE_STATUS.COMPLETED) {
    return { status: 400, message: 'Cannot cancel an ongoing or completed ride' };
  }
  if (s === RIDE_STATUS.SCHEDULED || s === RIDE_STATUS.PENDING || s === RIDE_STATUS.ACCEPTED) return null;
  return { status: 400, message: 'Cannot cancel ride in current state' };
}

export function assertCanModifyRide(ride) {
  if (!ride) return { status: 404, message: 'Ride request not found' };
  const s = normalizeRideStatus(ride.status);
  if (TERMINAL_RIDE.has(s)) {
    return rideTransitionError(ride.status, 'modify');
  }
  if (s === RIDE_STATUS.PENDING) return null;
  return { status: 400, message: 'Cannot modify ride after it has been accepted' };
}

export function assertCanVerifyOtp(ride, trip) {
  if (!ride) return { status: 404, message: 'Ride request not found' };
  if (!trip) return { status: 404, message: 'Trip not found' };

  const s = normalizeRideStatus(ride.status);
  if (s === RIDE_STATUS.ONGOING && !trip.otp_code) {
    return null; // idempotent — already started
  }
  if (TERMINAL_RIDE.has(s)) {
    return rideTransitionError(ride.status, 'start');
  }
  if (s !== RIDE_STATUS.ACCEPTED) {
    return { status: 400, message: 'Ride must be accepted before verifying OTP' };
  }
  if (!trip.otp_code) {
    return { status: 400, message: 'OTP already used or not set' };
  }
  return null;
}

export function assertCanCompleteTrip(ride, trip) {
  if (!trip) return { status: 404, message: 'Trip not found' };
  if (trip.ended_at) return null; // idempotent — handled by caller

  if (!ride) return { status: 400, message: 'Ride request not found' };
  const s = normalizeRideStatus(ride.status);
  if (s === RIDE_STATUS.CANCELLED) {
    return rideTransitionError(ride.status, 'complete');
  }
  if (s === RIDE_STATUS.COMPLETED) return null; // idempotent with ended trip
  if (s === RIDE_STATUS.ACCEPTED || s === RIDE_STATUS.ONGOING) return null;
  return { status: 400, message: 'Ride cannot be completed in current state' };
}

// In-memory OTP attempt limiter. The container runs a single replica (min=max=1), so a
// process-local map is sufficient to stop a malicious assigned driver from brute-forcing
// the 4-digit start code. Counts reset after the window or on a successful start.
const OTP_MAX_ATTEMPTS = 5;
const OTP_WINDOW_MS = 15 * 60 * 1000;
const otpAttempts = new Map(); // tripId -> { count, firstAt }

function registerOtpFailure(tripId) {
  const now = Date.now();
  const rec = otpAttempts.get(tripId);
  if (!rec || now - rec.firstAt > OTP_WINDOW_MS) {
    otpAttempts.set(tripId, { count: 1, firstAt: now });
    return 1;
  }
  rec.count += 1;
  return rec.count;
}

/**
 * Canonical OTP verify — starts trip (ride → ongoing).
 * PATCH /active-trip/:trip_id/verify-otp
 */
export async function verifyTripOtpAndStart(prisma, io, tripId, otp, userId) {
  // Opt otp_code back in for verify only (global omit #1292).
  const trip = await prisma.active_trip.findUnique({
    where: { trip_id: tripId },
    omit: { otp_code: false },
    include: { ride_request: true },
  });
  if (!trip) return { error: { status: 404, message: 'Trip not found' } };

  const denied = await assertTripAssignedToUser(prisma, trip, userId);
  if (denied) return { error: denied };

  const ride = trip.ride_request;
  const transitionErr = assertCanVerifyOtp(ride, trip);
  if (transitionErr) return { error: transitionErr };

  const rideStatus = normalizeRideStatus(ride?.status);
  if (rideStatus === RIDE_STATUS.ONGOING && !trip.otp_code) {
    return {
      ok: true,
      message: 'Trip already started',
      alreadyStarted: true,
      request_id: trip.request_id,
    };
  }

  if (otpAttempts.get(tripId)?.count >= OTP_MAX_ATTEMPTS) {
    return {
      error: {
        status: 429,
        message: 'Too many incorrect OTP attempts. Ask the rider to re-share the code, then try again shortly.',
      },
    };
  }

  if (trip.otp_code !== otp) {
    const attempts = registerOtpFailure(tripId);
    if (attempts >= OTP_MAX_ATTEMPTS) {
      return {
        error: {
          status: 429,
          message: 'Too many incorrect OTP attempts. Ask the rider to re-share the code, then try again shortly.',
        },
      };
    }
    return { error: { status: 400, message: 'Invalid OTP code' } };
  }

  otpAttempts.delete(tripId);

  await prisma.$transaction(async (tx) => {
    await tx.active_trip.update({
      where: { trip_id: tripId },
      data: { otp_code: null, started_at: new Date() },
    });
    await tx.ride_request.update({
      where: { ride_request_id: trip.request_id },
      data: { status: RIDE_STATUS.ONGOING },
    });
  });

  if (ride?.passenger_id) {
    io?.to(`user-${ride.passenger_id}`).emit(`trip-started-${trip.request_id}`, {
      message: 'Trip Started!',
      status: RIDE_STATUS.ONGOING,
    });
    notifyRider(io, 'started', {
      passengerId: ride.passenger_id,
      rideRequestId: trip.request_id,
      tripId: tripId,
      body: 'Enjoy the ride — track your trip in the app.',
    });
  }

  return {
    ok: true,
    message: 'OTP Verified. Trip is now ongoing!',
    request_id: trip.request_id,
  };
}
