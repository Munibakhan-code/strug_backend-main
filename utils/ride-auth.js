/**
 * Rideshare-only auth helpers.
 * Used by ride route handlers only — does not modify global JWT middleware.
 */

import {
  isDriverPresentForDispatch,
  presentDriverWhereExtra,
} from './driver-presence.js';
import { haversineKm } from './ride-fare.js';

export function getAuthUserId(req) {
  const id = Number(req.user?.user_id ?? req.user?.userId);
  return id && !Number.isNaN(id) ? id : null;
}

export function requireAuthUserId(req, res) {
  const userId = getAuthUserId(req);
  if (!userId) {
    res.status(401).json({ successful: false, message: 'Invalid session — please log in again' });
    return null;
  }
  return userId;
}

/**
 * Resolve driver_profile from JWT user.
 * optionalProfileIdHint is used only when it belongs to the same user.
 */
export async function resolveDriverProfileForUser(prisma, userId, optionalProfileIdHint = null, include = undefined) {
  let profile = await prisma.driver_profile.findFirst({
    where: { user_id: userId },
    orderBy: { driver_profile_id: 'asc' },
    ...(include ? { include } : {}),
  });

  const hint = Number(optionalProfileIdHint);
  if (hint && !Number.isNaN(hint)) {
    const hinted = await prisma.driver_profile.findUnique({
      where: { driver_profile_id: hint },
      ...(include ? { include } : {}),
    });
    if (hinted?.user_id === userId) profile = hinted;
  }

  return profile;
}

/**
 * Canonical driver profile = lowest driver_profile_id per user.
 * Online status for a user follows that row only (avoids duplicate-profile ghosts).
 */
export async function getCanonicalDriverProfile(prisma, userId) {
  if (!userId) return null;
  return prisma.driver_profile.findFirst({
    where: { user_id: userId },
    orderBy: { driver_profile_id: 'asc' },
  });
}

/** Count users whose canonical driver profile is actively present (online + recent ping). */
export async function countCanonicalOnlineDrivers(prisma) {
  const rows = await prisma.driver_profile.findMany({
    where: presentDriverWhereExtra(),
    select: { user_id: true, is_online: true, last_ping: true },
    orderBy: { driver_profile_id: 'asc' },
  });
  const canonicalPresent = new Map();
  for (const row of rows) {
    if (!row.user_id || canonicalPresent.has(row.user_id)) continue;
    canonicalPresent.set(row.user_id, isDriverPresentForDispatch(row));
  }
  let count = 0;
  for (const present of canonicalPresent.values()) {
    if (present) count += 1;
  }
  return count;
}

/**
 * Set is_online (and optional location) on ALL driver_profile rows for a user.
 * Returns the canonical profile after sync.
 */
export async function syncDriverOnlineStatusForUser(prisma, userId, { is_online, current_lat, current_long }) {
  const existing = await prisma.driver_profile.findFirst({
    where: { user_id: userId },
    orderBy: { driver_profile_id: 'asc' },
  });

  const data = {
    is_online,
    last_ping: new Date(),
    ...(current_lat != null ? { current_lat } : {}),
    ...(current_long != null ? { current_long } : {}),
  };

  // Retain the last *meaningfully different* location as prev_lat/prev_long so ride-dispatch
  // can approximate heading (direction of travel) between pings. GPS jitter on a near-stationary
  // driver would otherwise flip the heading randomly every ping, so only shift once the driver
  // has actually moved a non-trivial distance (~50m).
  if (
    existing?.current_lat != null && existing?.current_long != null
    && current_lat != null && current_long != null
  ) {
    const movedKm = haversineKm(existing.current_lat, existing.current_long, current_lat, current_long);
    if (movedKm > 0.05) {
      data.prev_lat = existing.current_lat;
      data.prev_long = existing.current_long;
      data.prev_ping_at = existing.last_ping ?? new Date();
    }
  }

  if (!existing) {
    return prisma.driver_profile.create({
      data: { user_id: userId, ...data },
    });
  }

  await prisma.driver_profile.updateMany({
    where: { user_id: userId },
    data,
  });

  return prisma.driver_profile.findFirst({
    where: { user_id: userId },
    orderBy: { driver_profile_id: 'asc' },
  });
}

/** Returns { status, message } if unauthorized, else null. */
export async function assertTripAssignedToUser(prisma, trip, userId) {
  if (!trip?.driver_id) {
    return { status: 403, message: 'Unauthorized action' };
  }
  const profile = await prisma.driver_profile.findUnique({
    where: { driver_profile_id: trip.driver_id },
    select: { user_id: true },
  });
  if (!profile || profile.user_id !== userId) {
    return { status: 403, message: 'Unauthorized action' };
  }
  return null;
}

/** Returns { status, message } if unauthorized, else null. */
export function assertPassengerOwnsRide(ride, userId) {
  if (Number(ride?.passenger_id) !== userId) {
    return { status: 403, message: 'Unauthorized action' };
  }
  return null;
}

/** Returns { status, message } if unauthorized, else null. */
export async function assertPassengerOwnsTrip(prisma, trip, userId) {
  if (!trip?.request_id) {
    return { status: 403, message: 'Unauthorized action' };
  }
  const ride = await prisma.ride_request.findUnique({
    where: { ride_request_id: trip.request_id },
    select: { passenger_id: true },
  });
  if (!ride || Number(ride.passenger_id) !== userId) {
    return { status: 403, message: 'Unauthorized action' };
  }
  return null;
}

/** Returns { status, message } if unauthorized, else null. */
export function assertDriverProfileOwnedByUser(profile, userId) {
  if (!profile || profile.user_id !== userId) {
    return { status: 403, message: 'Unauthorized action' };
  }
  return null;
}

/** Passenger or assigned/active-trip driver may read a ride request. */
export async function assertCanReadRide(prisma, ride, userId) {
  if (!ride) {
    return { status: 404, message: 'Ride request not found' };
  }
  if (Number(ride.passenger_id) === userId) {
    return null;
  }

  if (ride.assigned_driver_id) {
    const assigned = await prisma.driver_profile.findUnique({
      where: { driver_profile_id: ride.assigned_driver_id },
      select: { user_id: true },
    });
    if (assigned?.user_id === userId) {
      return null;
    }
  }

  const driverTrip = await prisma.active_trip.findFirst({
    where: {
      request_id: ride.ride_request_id,
      driver_profile: { user_id: userId },
    },
    select: { trip_id: true },
  });
  if (driverTrip) {
    return null;
  }

  return { status: 403, message: 'Unauthorized action' };
}

/** Passenger or assigned driver may read an active trip. */
export async function assertCanReadTrip(prisma, trip, userId) {
  if (!trip) {
    return { status: 404, message: 'Active trip not found' };
  }

  const asDriver = await assertTripAssignedToUser(prisma, trip, userId);
  if (!asDriver) {
    return null;
  }

  const asPassenger = await assertPassengerOwnsTrip(prisma, trip, userId);
  if (!asPassenger) {
    return null;
  }

  return { status: 403, message: 'Unauthorized action' };
}

/** Prisma where-clause: active trips visible to this user (passenger or driver). */
export async function activeTripReadFilterForUser(prisma, userId) {
  const profiles = await prisma.driver_profile.findMany({
    where: { user_id: userId },
    select: { driver_profile_id: true },
  });
  const driverIds = profiles.map((p) => p.driver_profile_id);

  const or = [{ ride_request: { passenger_id: userId } }];
  if (driverIds.length > 0) {
    or.push({ driver_id: { in: driverIds } });
  }
  return { OR: or };
}
