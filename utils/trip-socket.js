import prisma from './prisma-client.js';

const tripLocationLastEmit = new Map();

/** Rate-limit trip location broadcasts (default 3s per trip). */
export function shouldEmitTripLocation(tripId, minIntervalMs = 3000) {
  const key = String(tripId);
  const now = Date.now();
  const last = tripLocationLastEmit.get(key) ?? 0;
  if (now - last < minIntervalMs) return false;
  tripLocationLastEmit.set(key, now);
  return true;
}

export function buildTripLocationPayload(tripId, lat, lng) {
  const latitude = Number(lat);
  const longitude = Number(lng);
  return {
    trip_id: Number(tripId),
    lat: latitude,
    lng: longitude,
    long: longitude,
    timestamp: new Date().toISOString(),
  };
}

/** Notify trip room that the trip is over — clients should leave and stop tracking. */
export function emitTripEnded(io, tripId, reason = 'completed') {
  if (!io || tripId == null) return;
  const id = Number(tripId);
  if (!id || Number.isNaN(id)) return;
  io.to(`trip_${id}`).emit('trip-ended', { trip_id: id, reason });
  tripLocationLastEmit.delete(String(id));
}

/** True if user is passenger or assigned driver on an open trip. */
export async function isTripPartyUser(tripId, userId) {
  if (!tripId || !userId) return false;
  const trip = await prisma.active_trip.findFirst({
    where: {
      trip_id: Number(tripId),
      ended_at: null,
      OR: [
        { ride_request: { passenger_id: Number(userId) } },
        { driver_profile: { user_id: Number(userId) } },
      ],
    },
    select: { trip_id: true },
  });
  return !!trip;
}

/** Broadcast driver GPS to trip room and persist on driver_profile. */
export async function publishDriverTripLocation(io, tripId, lat, lng, { minIntervalMs = 3000 } = {}) {
  if (!io || tripId == null || lat == null || lng == null) return false;
  const id = Number(tripId);
  if (!id || Number.isNaN(id)) return false;
  if (!shouldEmitTripLocation(id, minIntervalMs)) return false;

  const trip = await prisma.active_trip.findFirst({
    where: { trip_id: id, ended_at: null },
    select: { trip_id: true, driver_id: true },
  });
  if (!trip?.driver_id) return false;

  await prisma.driver_profile
    .update({
      where: { driver_profile_id: trip.driver_id },
      data: {
        current_lat: Number(lat),
        current_long: Number(lng),
        last_ping: new Date(),
      },
    })
    .catch(() => {});

  io.to(`trip_${id}`).emit('driver-location-updated', buildTripLocationPayload(id, lat, lng));
  return true;
}
