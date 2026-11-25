import prisma from './prisma-client.js';
// Single-flight across replicas: without this every replica fires the same tick.
import { scheduleInterval } from './cron-lock.js';

/** Seconds a driver sees an offer before it moves to the next driver (default 120). */
export const DRIVER_OFFER_TIMEOUT_SEC = Number(process.env.RIDE_DRIVER_OFFER_TIMEOUT_SEC || 120);

/** Dev-only: emit incoming offers to all online drivers in range (not just nearest). */
export const BROADCAST_ALL_DRIVERS =
  process.env.RIDESHARE_BROADCAST_ALL === 'true' || process.env.NODE_ENV !== 'production';

const SEARCH_RADIUS_KM = 10;

/**
 * Composite scoring weights for candidate ranking (findDriverCandidates below).
 * Distance stays the dominant factor by design — these are capped km-equivalent
 * penalties added on top, not multipliers, so a much-closer driver never loses to a
 * marginally-better-aligned or higher-acceptance one further away.
 */
const HEADING_PENALTY_MAX_KM = Number(process.env.RIDE_HEADING_PENALTY_MAX_KM || 2);
const ACCEPTANCE_PENALTY_MAX_KM = Number(process.env.RIDE_ACCEPTANCE_PENALTY_MAX_KM || 3);
/** A driver needs at least this many accept+decline events before acceptance rate affects scoring. */
export const MIN_HISTORY_FOR_ACCEPTANCE_SCORING = 5;

import { computeRecommendedFareForRide, haversineKm, resolveMultiStopRouteMetrics, resolveRouteMetrics } from './ride-fare.js';
import { logCronError } from './cron-email.js';
import { computeRideSettlement } from './ride-settlement.js';
import { emitTripEnded } from './trip-socket.js';
import { presentDriverWhereExtra, isDriverPresentForDispatch } from './driver-presence.js';
import { getBusyDriverProfileIds } from './driver-busy.js';
import { refundPassengerRideIfPaid, resolvePassengerCancelFeeRate } from './ride-refund.js';
import { buildRideCancellationMessage } from './ride-cancellation.js';
import { notify } from '../services/notify.js';
import { notifyRider } from './ride-rider-notify.js';
import { areUsersBlockedOnPlatform } from './platform-blocks.js';

export { haversineKm };

function isValidCoord(lat, lng) {
  const la = Number(lat);
  const lo = Number(lng);
  return Number.isFinite(la) && Number.isFinite(lo)
    && Math.abs(la) <= 90 && Math.abs(lo) <= 180
    && !(Math.abs(la) < 0.01 && Math.abs(lo) < 0.01);
}

function formatDistanceKm(km) {
  if (!Number.isFinite(km) || km < 0) return '—';
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

/** Compass bearing (0-360°) from point 1 to point 2. */
function bearingDeg(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const deltaLambda = toRad(lon2 - lon1);
  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Smallest angle (0-180°) between two bearings. */
function bearingDiffDeg(a, b) {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/**
 * 0 (heading straight at the pickup) .. HEADING_PENALTY_MAX_KM (heading directly away).
 * Neutral (0) when the driver has no established heading yet (just came online, or hasn't
 * moved far enough since the last ping to distinguish real travel from GPS jitter).
 */
function headingPenaltyKm(driver, pickup_lat, pickup_long) {
  if (!isValidCoord(driver.prev_lat, driver.prev_long) || !isValidCoord(driver.current_lat, driver.current_long)) {
    return 0;
  }
  const heading = bearingDeg(driver.prev_lat, driver.prev_long, driver.current_lat, driver.current_long);
  const toPickup = bearingDeg(driver.current_lat, driver.current_long, pickup_lat, pickup_long);
  const diff = bearingDiffDeg(heading, toPickup);
  return (diff / 180) * HEADING_PENALTY_MAX_KM;
}

/**
 * 0 (reliably accepts offers, or too new to judge) .. ACCEPTANCE_PENALTY_MAX_KM (mostly
 * declines/ignores offers). Protects ride quality without permanently punishing new drivers.
 */
function acceptancePenaltyKm(driver) {
  const accepted = driver.accept_count || 0;
  const declined = driver.decline_count || 0;
  const total = accepted + declined;
  if (total < MIN_HISTORY_FOR_ACCEPTANCE_SCORING) return 0;
  const acceptanceRate = accepted / total;
  return (1 - acceptanceRate) * ACCEPTANCE_PENALTY_MAX_KM;
}

/** ETA from distance at ~30 km/h (driver → pickup). */
function formatEtaFromDistanceKm(distanceKm) {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) return '—';
  const etaMin = (distanceKm / 30) * 60;
  return `~${Math.max(1, Math.round(etaMin))} min`;
}

function formatDurationMin(durationMin) {
  if (!Number.isFinite(durationMin) || durationMin < 0) return '—';
  return `~${Math.max(1, Math.round(durationMin))} min`;
}

async function resolveTripMetrics(rideRequest) {
  const metrics = await resolveRouteMetrics({
    pickup: rideRequest.pickup_address,
    dropoff: rideRequest.drop_address,
    pickup_lat: rideRequest.pickup_lat,
    pickup_long: rideRequest.pickup_long,
    drop_lat: rideRequest.drop_lat,
    drop_long: rideRequest.drop_long,
  });
  if (metrics?.dist_km > 0) {
    return { dist_km: metrics.dist_km, duration_min: metrics.duration_min };
  }
  if (
    isValidCoord(rideRequest.pickup_lat, rideRequest.pickup_long)
    && isValidCoord(rideRequest.drop_lat, rideRequest.drop_long)
  ) {
    const dist_km = haversineKm(
      rideRequest.pickup_lat,
      rideRequest.pickup_long,
      rideRequest.drop_lat,
      rideRequest.drop_long,
    );
    return { dist_km, duration_min: (dist_km / 30) * 60 };
  }
  return null;
}

/** Compute recommended fare — same calculator as POST /fare-estimate (estimate = charge). */
export async function computeEstimatedFare(rideRequest) {
  return computeRecommendedFareForRide(prisma, {
    pickup_address: rideRequest.pickup_address,
    drop_address: rideRequest.drop_address,
    pickup_lat: rideRequest.pickup_lat,
    pickup_long: rideRequest.pickup_long,
    drop_lat: rideRequest.drop_lat,
    drop_long: rideRequest.drop_long,
    stops: rideRequest.ride_stop || rideRequest.stops || [],
    requested_type_id: rideRequest.requested_type_id,
    vehicle_type: rideRequest.vehicle_type,
    offered_fare: rideRequest.offered_fare,
  });
}

function resolveRiderFare(rideRequest) {
  const total = rideRequest.offered_fare ?? rideRequest.estimated_fare ?? null;
  const settlement = computeRideSettlement(total);
  return {
    estimated_fare: settlement.total_fare,
    driver_payout: settlement.driver_payout,
  };
}

/**
 * Build driver incoming-offer payload.
 * `distance` / `eta` = passenger trip (pickup → dropoff), matching fare-estimate route.
 * Optional `pickup_distance` / `pickup_eta` = driver current location → pickup.
 */
export async function buildOfferPayload(rideRequest, driverDistanceKm = null) {
  const { driver_payout } = resolveRiderFare(rideRequest);
  const trip = await resolveMultiStopRouteMetrics({
    pickup: rideRequest.pickup_address,
    dropoff: rideRequest.drop_address,
    pickup_lat: rideRequest.pickup_lat,
    pickup_long: rideRequest.pickup_long,
    drop_lat: rideRequest.drop_lat,
    drop_long: rideRequest.drop_long,
    stops: rideRequest.ride_stop || [],
  });

  const payload = {
    request_id: rideRequest.ride_request_id,
    pickup_location: rideRequest.pickup_address ?? 'Pickup',
    dropoff_location: rideRequest.drop_address ?? 'Dropoff',
    driver_payout,
    distance: trip ? formatDistanceKm(trip.dist_km) : '—',
    eta: trip ? formatDurationMin(trip.duration_min) : '—',
    trip_distance_km: trip?.dist_km ?? null,
    trip_duration_min: trip?.duration_min ?? null,
    stops: Array.isArray(rideRequest.ride_stop)
      ? rideRequest.ride_stop
        .sort((a, b) => a.sequence - b.sequence)
        .map((stop) => ({
          ride_stop_id: stop.ride_stop_id,
          sequence: stop.sequence,
          address: stop.address,
          status: stop.status,
        }))
      : [],
    expires_at: rideRequest.offer_expires_at?.toISOString?.() ?? null,
    offer_timeout_sec: DRIVER_OFFER_TIMEOUT_SEC,
  };

  if (Number.isFinite(driverDistanceKm) && driverDistanceKm >= 0) {
    payload.pickup_distance = formatDistanceKm(driverDistanceKm);
    payload.pickup_eta = formatEtaFromDistanceKm(driverDistanceKm);
  }

  return payload;
}

function availableDriverWhere(excludedDriverIds = [], busyDriverIds = new Set()) {
  const notIn = [...new Set([...excludedDriverIds, ...busyDriverIds])];
  return {
    driver_profile_id: { notIn: notIn.length ? notIn : [-1] },
    accepts_rides: true,
    ...presentDriverWhereExtra(),
  };
}

/** One row per user — lowest driver_profile_id is canonical. */
function dedupeToCanonicalProfiles(profiles) {
  const byUser = new Map();
  for (const p of profiles) {
    if (!p.user_id) continue;
    const cur = byUser.get(p.user_id);
    if (!cur || p.driver_profile_id < cur.driver_profile_id) {
      byUser.set(p.user_id, p);
    }
  }
  return [...byUser.values()];
}

export async function countAvailableDriversExcluding(excludedDriverIds = []) {
  const excluded = new Set(
    (excludedDriverIds || []).map(Number).filter((id) => !Number.isNaN(id)),
  );
  const busy = await getBusyDriverProfileIds();
  const rows = await prisma.driver_profile.findMany({
    where: { ...presentDriverWhereExtra(), accepts_rides: true },
    select: { driver_profile_id: true, user_id: true, is_online: true, last_ping: true },
    orderBy: { driver_profile_id: 'asc' },
  });
  let count = 0;
  const seenUsers = new Set();
  for (const row of rows) {
    if (!row.user_id || seenUsers.has(row.user_id)) continue;
    if (!isDriverPresentForDispatch(row)) continue;
    if (busy.has(row.driver_profile_id)) continue;
    seenUsers.add(row.user_id);
    if (!excluded.has(row.driver_profile_id)) count += 1;
  }
  return count;
}

export async function findDriverCandidates(pickup_lat, pickup_long, excludedDriverIds = []) {
  const latDelta = SEARCH_RADIUS_KM / 111;
  const longDelta = SEARCH_RADIUS_KM / (111 * Math.cos((pickup_lat * Math.PI) / 180));
  const busy = await getBusyDriverProfileIds();

  let candidates = await prisma.driver_profile.findMany({
    where: {
      ...availableDriverWhere(excludedDriverIds, busy),
      current_lat: { gte: pickup_lat - latDelta, lte: pickup_lat + latDelta },
      current_long: { gte: pickup_long - longDelta, lte: pickup_long + longDelta },
    },
    include: { user: true },
  });

  if (candidates.length === 0) {
    candidates = await prisma.driver_profile.findMany({
      where: availableDriverWhere(excludedDriverIds, busy),
      include: { user: true },
    });
  }

  const canonical = dedupeToCanonicalProfiles(candidates).filter(
    (d) => !excludedDriverIds.length || !excludedDriverIds.includes(d.driver_profile_id),
  );

  return canonical
    .map((d) => {
      const distance_km = isValidCoord(d.current_lat, d.current_long)
        ? haversineKm(pickup_lat, pickup_long, d.current_lat, d.current_long)
        : Number.POSITIVE_INFINITY;
      // Composite ranking score: distance stays dominant, heading/acceptance are capped
      // penalties layered on top (see constants above) — never a raw sort-by-distance.
      const score = Number.isFinite(distance_km)
        ? distance_km + headingPenaltyKm(d, pickup_lat, pickup_long) + acceptancePenaltyKm(d)
        : distance_km;
      return { ...d, distance_km, score };
    })
    .sort((a, b) => a.score - b.score);
}

async function assignAndEmitOffer(io, rideRequest, candidates) {
  if (!candidates.length) return null;

  const eligibleCandidates = [];
  const pushIfEligible = async (candidate) => {
    if (!candidate.user_id || !rideRequest.passenger_id) {
      eligibleCandidates.push(candidate);
      return true;
    }
    if (await areUsersBlockedOnPlatform(rideRequest.passenger_id, candidate.user_id)) return false;
    eligibleCandidates.push(candidate);
    return true;
  };

  for (const candidate of candidates) {
    const eligible = await pushIfEligible(candidate);
    if (eligible && !BROADCAST_ALL_DRIVERS) break;
  }
  if (!eligibleCandidates.length) return null;

  const topCandidate = eligibleCandidates[0];
  const offerExpiresAt = new Date(Date.now() + DRIVER_OFFER_TIMEOUT_SEC * 1000);

  const updatedRide = await prisma.ride_request.update({
    where: { ride_request_id: rideRequest.ride_request_id },
    data: {
      assigned_driver_id: topCandidate.driver_profile_id,
      offer_expires_at: offerExpiresAt,
    },
  });

  const basePayload = await buildOfferPayload(updatedRide, null);

  if (BROADCAST_ALL_DRIVERS) {
    for (const driver of eligibleCandidates) {
      if (!driver.user_id) continue;
      const driverKm = Number.isFinite(driver.distance_km) && driver.distance_km < 1e6
        ? driver.distance_km
        : null;
      emitOfferToDriver(io, driver.user_id, {
        ...basePayload,
        ...(driverKm != null
          ? {
            pickup_distance: formatDistanceKm(driverKm),
            pickup_eta: formatEtaFromDistanceKm(driverKm),
          }
          : {}),
      }, updatedRide.passenger_id);
    }
  } else if (topCandidate.user_id) {
    const driverKm = Number.isFinite(topCandidate.distance_km) && topCandidate.distance_km < 1e6
      ? topCandidate.distance_km
      : null;
    emitOfferToDriver(io, topCandidate.user_id, await buildOfferPayload(updatedRide, driverKm), updatedRide.passenger_id);
  }

  return topCandidate.driver_profile_id;
}

function emitOfferToDriver(io, userId, payload, actorUserId = null) {
  // Existing real-time path — kept verbatim so the driver dashboard's live listener is unchanged.
  io.to(`user-${userId}`).emit(`ride-request-${userId}`, payload);

  // Epic 10: also persist a durable, actionable notification. This is the win — a ride offer used
  // to exist only as this fire-and-forget socket emit, so if the driver's socket was down the
  // offer was silently lost (only the 3s poll recovered it). Now it survives a dropped socket,
  // lands in the global bell, and (once VAPID is set) fires a web push. Fire-and-forget: notify()
  // never throws, and dispatch must not wait on it.
  notify(io, {
    userId,
    actorUserId,
    vertical: 'rideshare',
    type: 'ride.offer',
    urgency: 'actionable',
    title: 'Incoming ride request',
    body: payload.driver_payout != null
      ? `${payload.pickup_location} → ${payload.dropoff_location}`
      : null,
    entityType: 'ride_request',
    entityId: payload.request_id,
    actionUrl: 'sd-drive',
    data: payload,
    expiresAt: payload.expires_at ? new Date(payload.expires_at) : null,
  });
}

/** Remove offer from one driver's UI (e.g. they declined). Never broadcast globally. */
export async function notifyOfferClosedToDriverProfile(io, driverProfileId, rideRequestId, reason = 'declined', userId = null) {
  if (!io || !driverProfileId || !rideRequestId) return;

  let targetUserId = userId != null ? Number(userId) : null;
  if (!targetUserId || Number.isNaN(targetUserId)) {
    const profile = await prisma.driver_profile.findUnique({
      where: { driver_profile_id: Number(driverProfileId) },
      select: { user_id: true },
    });
    targetUserId = profile?.user_id != null ? Number(profile.user_id) : null;
  }
  if (!targetUserId) return;

  const payload = {
    request_id: rideRequestId,
    driver_profile_id: Number(driverProfileId),
    reason,
  };
  io.to(`user-${targetUserId}`).emit(`ride-offer-closed-profile-${driverProfileId}`, payload);
}

/** @deprecated Prefer notifyOfferClosedToDriverProfile for decline flows */
export function notifyOfferClosedToDriver(io, userId, rideRequestId, reason = 'declined') {
  if (!io || !userId || !rideRequestId) return;
  io.to(`user-${userId}`).emit(`ride-offer-closed-${userId}`, { request_id: rideRequestId, reason });
}

/** Cancel a ride request and clear it from all driver UIs. Refunds paid rides (pending/accepted). */
export async function cancelRideRequest(io, rideRequestId, passengerId = null, reason = 'cancelled') {
  const ride = await prisma.ride_request.findUnique({ where: { ride_request_id: rideRequestId } });
  if (!ride || ride.status === 'cancelled') {
    return { cancelled: false, refund: null };
  }
  const priorStatus = ride.status;
  const pid = passengerId ?? ride.passenger_id;

  const openTrips = await prisma.active_trip.findMany({
    where: { request_id: rideRequestId, ended_at: null },
    select: { trip_id: true },
  });
  await prisma.$transaction(async (tx) => {
    await tx.ride_request.update({
      where: { ride_request_id: rideRequestId },
      data: {
        status: 'cancelled',
        assigned_driver_id: null,
        offer_expires_at: null,
        cancellation_reason: reason,
      },
    });
    await tx.active_trip.updateMany({
      where: { request_id: rideRequestId, ended_at: null },
      data: { ended_at: new Date() },
    });
  });
  for (const t of openTrips) {
    emitTripEnded(io, t.trip_id, reason);
  }
  await notifyOfferClosedToDrivers(io, rideRequestId, null, driverOfferCloseReason(reason));

  let refund = null;
  if (priorStatus === 'pending' || priorStatus === 'accepted') {
    const cancelFeeRate = resolvePassengerCancelFeeRate(priorStatus, reason);
    refund = await refundPassengerRideIfPaid({
      rideRequestId,
      passengerId: pid,
      reason,
      cancelFeeRate,
    }).catch((err) => {
      console.error(`[ride-dispatch] refund failed for ride #${rideRequestId}:`, err.message);
      return { refunded: false, error: err.message };
    });
  }

  if (pid) {
    const message = buildRideCancellationMessage(reason, refund);
    io?.to(`user-${pid}`).emit(`ride-cancelled-${pid}`, {
      ride_request_id: rideRequestId,
      reason,
      refund: !!refund?.refunded,
      refund_amount: refund?.refunded ? refund.amount : null,
      cancel_fee: refund?.cancel_fee > 0 ? refund.cancel_fee : null,
      paid_amount: refund?.paid_amount ?? null,
      message,
    });
    // A passenger who tapped cancel themselves already got a confirmation in that flow — a bell
    // row + push would just be noise. Every other reason (driver cancelled, no driver found,
    // all drivers declined, a no-show close) is news the rider needs even with the tab closed.
    if (reason !== 'cancelled_by_passenger') {
      const title = reason === 'no_driver_available' || reason === 'no_driver_found' || reason === 'all_drivers_declined'
        ? "We couldn't find a driver"
        : 'Your ride was cancelled';
      notifyRider(io, 'cancelled', {
        passengerId: pid,
        rideRequestId,
        title,
        body: message,
        data: {
          reason,
          refunded: !!refund?.refunded,
          refund_amount: refund?.refunded ? refund.amount : null,
        },
      });
    }
  }

  return { cancelled: true, refund };
}

/** All driver_profile ids for a user (handles duplicate profile rows). */
export async function driverProfileIdsForUser(userId) {
  if (!userId) return [];
  const rows = await prisma.driver_profile.findMany({
    where: { user_id: Number(userId) },
    select: { driver_profile_id: true },
  });
  return rows.map((r) => r.driver_profile_id);
}

function declinedListIncludes(declined, profileId) {
  const target = Number(profileId);
  return (declined || []).some((id) => Number(id) === target);
}

function rideDeclinedByDriver(ride, driverProfileId, userProfileIds = []) {
  const declined = ride.declined_driver_ids || [];
  const ids = [Number(driverProfileId), ...userProfileIds.map(Number)].filter(Boolean);
  return ids.some((id) => declinedListIncludes(declined, id));
}

/**
 * Cancel stale pending/accepted rides blocking a new booking.
 * Throws if passenger has an active trip in progress.
 */
export async function releasePassengerBlockingRequests(tx, passengerId) {
  const cancelledIds = [];
  const blocking = await tx.ride_request.findMany({
    where: {
      passenger_id: Number(passengerId),
      status: { in: ['pending', 'pending_payment', 'accepted'] },
    },
    include: { active_trip: true },
  });

  for (const req of blocking) {
    const openTrip = (req.active_trip || []).find((t) => t.ended_at == null);
    if (openTrip) {
      const err = new Error('You already have a ride in progress.');
      err.code = 'RIDE_IN_PROGRESS';
      throw err;
    }
    await tx.active_trip.updateMany({
      where: { request_id: req.ride_request_id, ended_at: null },
      data: { ended_at: new Date() },
    });
    await tx.ride_request.update({
      where: { ride_request_id: req.ride_request_id },
      data: {
        status: 'cancelled',
        assigned_driver_id: null,
        offer_expires_at: null,
        cancellation_reason: 'replaced_by_new_booking',
      },
    });
    cancelledIds.push(req.ride_request_id);
  }
  return cancelledIds;
}

/** Tell all online drivers to drop a ride offer from their UI (accepted elsewhere, completed, cancelled). */
export async function notifyOfferClosedToDrivers(
  io,
  rideRequestId,
  exceptDriverProfileId = null,
  closeReason = 'no_longer_available',
) {
  if (!io || !rideRequestId) return;
  const drivers = await prisma.driver_profile.findMany({
    where: presentDriverWhereExtra(),
    select: { user_id: true, driver_profile_id: true },
  });
  for (const d of drivers) {
    if (exceptDriverProfileId != null && d.driver_profile_id === exceptDriverProfileId) continue;
    if (d.user_id) {
      io.to(`user-${d.user_id}`).emit(`ride-offer-closed-${d.user_id}`, {
        request_id: rideRequestId,
        reason: closeReason,
      });
    }
  }
}

/** Map ride cancel reason → driver offer-closed socket reason. */
export function driverOfferCloseReason(cancelReason) {
  return cancelReason === 'cancelled_by_passenger' ? 'cancelled_by_passenger' : 'no_longer_available';
}

/** Declined + timed-out driver ids — try next driver before re-offering the same one. */
export function buildTimeoutExcludeIds(declinedDriverIds = [], timedOutDriverId = null) {
  const declined = (declinedDriverIds || []).map(Number).filter((id) => !Number.isNaN(id));
  const timedOut = Number(timedOutDriverId);
  if (Number.isFinite(timedOut) && timedOut > 0) declined.push(timedOut);
  return [...new Set(declined)];
}

export async function dispatchRideToNextDriver(io, rideRequest, excludedDriverIds = []) {
  const { pickup_lat, pickup_long } = rideRequest;
  if (pickup_lat == null || pickup_long == null) return null;

  const candidates = await findDriverCandidates(pickup_lat, pickup_long, excludedDriverIds);
  if (candidates.length === 0) {
    return null;
  }

  return assignAndEmitOffer(io, rideRequest, candidates);
}

/**
 * After a driver declines: mark declined, re-offer to remaining drivers.
 * Never mass-close other drivers unless the ride is truly cancelled.
 */
export async function reofferRideAfterDecline(io, rideRequestId, decliningDriverProfileId, decliningUserId = null) {
  const ride = await prisma.ride_request.findUnique({ where: { ride_request_id: rideRequestId } });
  if (!ride || ride.status !== 'pending') {
    return { reoffered: false, cancelled: false };
  }

  const userProfileIds = decliningUserId
    ? await driverProfileIdsForUser(decliningUserId)
    : [Number(decliningDriverProfileId)];
  const excluded = [
    ...new Set([
      ...(ride.declined_driver_ids || []).map(Number),
      ...userProfileIds.map(Number),
    ]),
  ].filter((id) => !Number.isNaN(id));

  await prisma.ride_request.update({
    where: { ride_request_id: rideRequestId },
    data: { declined_driver_ids: excluded },
  });

  // Feeds the acceptance-rate factor in driver scoring — see findDriverCandidates below.
  await prisma.driver_profile.update({
    where: { driver_profile_id: Number(decliningDriverProfileId) },
    data: { decline_count: { increment: 1 } },
  }).catch(() => null);

  for (const profileId of userProfileIds) {
    await notifyOfferClosedToDriverProfile(io, profileId, rideRequestId, 'declined', decliningUserId);
  }

  if (ride.pickup_lat == null || ride.pickup_long == null) {
    return { reoffered: false, cancelled: false, pending_redispatch: true };
  }

  const remainingCandidates = await findDriverCandidates(
    ride.pickup_lat,
    ride.pickup_long,
    excluded
  );

  if (remainingCandidates.length > 0) {
    const refreshed = await prisma.ride_request.findUnique({
      where: { ride_request_id: rideRequestId },
    });
    if (refreshed?.status !== 'pending') {
      return { reoffered: false, cancelled: false };
    }
    const nextDriverId = await assignAndEmitOffer(io, refreshed, remainingCandidates);
    return {
      reoffered: true,
      cancelled: false,
      next_driver_id: nextDriverId,
      remaining_driver_count: remainingCandidates.length,
    };
  }

  const eligibleCount = await countAvailableDriversExcluding(excluded);
  if (eligibleCount === 0) {
    await cancelRideRequest(io, rideRequestId, ride.passenger_id, 'all_drivers_declined');
    return { reoffered: false, cancelled: true };
  }

  await prisma.ride_request.update({
    where: { ride_request_id: rideRequestId },
    data: { assigned_driver_id: null, offer_expires_at: null },
  });

  return { reoffered: false, cancelled: false, pending_redispatch: true };
}

/**
 * When an offer times out, try the next driver.
 * Timeout does NOT add the driver to declined_driver_ids (only explicit decline does).
 * If only one driver is online, the offer is refreshed for that same driver.
 */
export async function processExpiredOffers(io) {
  const now = new Date();
  const expired = await prisma.ride_request.findMany({
    where: {
      status: 'pending',
      assigned_driver_id: { not: null },
      offer_expires_at: { lt: now },
    },
  });

  for (const ride of expired) {
    const hasTrip = await prisma.active_trip.count({ where: { request_id: ride.ride_request_id } });
    if (hasTrip > 0) continue;

    const timedOutDriverId = ride.assigned_driver_id;
    const declinedOnly = ride.declined_driver_ids || [];
    const tryExclude = buildTimeoutExcludeIds(declinedOnly, timedOutDriverId);

    if (timedOutDriverId) {
      await notifyOfferClosedToDriverProfile(io, timedOutDriverId, ride.ride_request_id, 'expired');
      // A timeout is "ignored the offer" — counts against acceptance rate same as an explicit decline.
      await prisma.driver_profile.update({
        where: { driver_profile_id: timedOutDriverId },
        data: { decline_count: { increment: 1 } },
      }).catch(() => null);
    }

    await prisma.ride_request.update({
      where: { ride_request_id: ride.ride_request_id },
      data: { assigned_driver_id: null, offer_expires_at: null },
    });

    const refreshed = await prisma.ride_request.findUnique({
      where: { ride_request_id: ride.ride_request_id },
    });
    if (refreshed?.status !== 'pending') continue;

    let next = await dispatchRideToNextDriver(io, refreshed, tryExclude);
    if (!next) {
      next = await dispatchRideToNextDriver(io, refreshed, declinedOnly);
    }
    if (!next) {
      await cancelRideRequest(io, ride.ride_request_id, ride.passenger_id, 'no_driver_found');
    }
  }
}

export function startRideDispatchCron(io) {
  scheduleInterval('ride-dispatch', () => {
    // No longer auto-flips is_online=false on a stale ping (see driver-presence.js) — the
    // online/offline switch is driver-controlled only now, so it survives a closed tab/app and
    // offers still reach them by push. Dispatch itself still requires a fresh last_ping
    // (presentDriverWhereExtra/isDriverPresentForDispatch below), so a driver whose location has
    // actually gone stale is silently skipped for new nearest-match rides either way.
    processExpiredOffers(io).catch((err) => logCronError('ride-dispatch-expired', err));
    redispatchOrphanedPendingRides(io).catch((err) => logCronError('ride-dispatch-redispatch', err));
  }, 5_000);
}

export function driverIsAvailable(profile) {
  return isDriverPresentForDispatch(profile);
}

function offerIsActive(ride, now) {
  if (ride.status !== 'pending') return false;
  if (!ride.offer_expires_at) return true;
  return ride.offer_expires_at > now;
}

export async function getIncomingOffersForDriver(driverProfileId) {
  const now = new Date();
  const profile = await prisma.driver_profile.findUnique({
    where: { driver_profile_id: driverProfileId },
  });
  if (!driverIsAvailable(profile)) return [];

  const userProfileIds = profile?.user_id ? await driverProfileIdsForUser(profile.user_id) : [driverProfileId];

  const where = {
    status: 'pending',
    active_trip: { none: {} },
  };

  if (!BROADCAST_ALL_DRIVERS) {
    where.assigned_driver_id = { in: userProfileIds };
    where.OR = [
      { offer_expires_at: { gt: now } },
      { offer_expires_at: null },
    ];
  } else {
    where.OR = [
      { offer_expires_at: { gt: now } },
      { offer_expires_at: null },
    ];
  }

  const rides = await prisma.ride_request.findMany({
    where,
    orderBy: { created_at: 'desc' },
    take: 20,
    include: { vehicle_types: true },
  });

  const active = rides
    .filter((r) => offerIsActive(r, now))
    .filter((r) => !rideDeclinedByDriver(r, driverProfileId, userProfileIds));

  return Promise.all(active.map(async (r) => {
    let driverDistKm = null;
    if (
      isValidCoord(profile.current_lat, profile.current_long)
      && isValidCoord(r.pickup_lat, r.pickup_long)
    ) {
      driverDistKm = haversineKm(
        r.pickup_lat,
        r.pickup_long,
        profile.current_lat,
        profile.current_long,
      );
    }
    return buildOfferPayload(r, driverDistKm);
  }));
}

/** Re-offer pending rides that lost their assignment (e.g. after timeout handoff). */
export async function redispatchOrphanedPendingRides(io) {
  const now = new Date();
  const orphaned = await prisma.ride_request.findMany({
    where: {
      status: 'pending',
      assigned_driver_id: null,
      active_trip: { none: {} },
      OR: [{ offer_expires_at: null }, { offer_expires_at: { gt: now } }],
    },
    take: 10,
  });

  for (const ride of orphaned) {
    const excluded = ride.declined_driver_ids || [];
    const eligible = await countAvailableDriversExcluding(excluded);
    if (eligible === 0) {
      const ageMs = now - new Date(ride.created_at).getTime();
      if (ageMs < DRIVER_OFFER_TIMEOUT_SEC * 1000) {
        continue;
      }
      await cancelRideRequest(io, ride.ride_request_id, ride.passenger_id, 'no_driver_found');
      continue;
    }
    await dispatchRideToNextDriver(io, ride, excluded).catch(() => null);
  }
}
