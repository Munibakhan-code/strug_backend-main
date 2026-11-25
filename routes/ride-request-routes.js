import express from 'express';
import crypto from 'crypto';
import Stripe from 'stripe';
import prisma from '../utils/prisma-client.js';
import { clientErrorMessage } from '../utils/client-error.js';
import { authenticateToken, requireAdmin } from '../middleware/authentication.js';
import {
  validateChargeAmount,
  getExpectedChargeForRide,
} from '../utils/ride-payment-safety.js';
import { rideFail, rideOk } from '../utils/ride-api-response.js';
import { getDistanceMatrix, getCountryFromCoords, geocodeAddress } from '../utils/google-maps.js';
import {
  FARE_RATES,
  buildFareEstimateResponse,
  buildAllFareEstimatesResponse,
  rideQuoteInputs,
} from '../utils/ride-fare.js';
import { verifyQuote, signQuote } from '../utils/price-quote.js';
import { getRegionData } from '../utils/tax-config.js';
import { applyVerticalIdentity, verticalIdentityUserInclude } from '../utils/vertical-identity.js';
import {
  haversineKm,
  dispatchRideToNextDriver,
  getIncomingOffersForDriver,
  computeEstimatedFare,
  BROADCAST_ALL_DRIVERS,
  DRIVER_OFFER_TIMEOUT_SEC,
  notifyOfferClosedToDrivers,
  reofferRideAfterDecline,
  cancelRideRequest,
  releasePassengerBlockingRequests,
} from '../utils/ride-dispatch.js';
import {
  requireAuthUserId,
  resolveDriverProfileForUser,
  assertPassengerOwnsRide,
  assertCanReadRide,
  countCanonicalOnlineDrivers,
  getCanonicalDriverProfile,
} from '../utils/ride-auth.js';
import {
  assertCanAcceptRide,
  assertCanCancelRide,
  assertCanModifyRide,
  verifyTripOtpAndStart,
} from '../utils/ride-state-machine.js';
import { formatPassengerTripHistoryItem } from '../utils/ride-passenger-history.js';
import { buildRideReceiptPayload } from '../utils/ride-receipt.js';
import { buildRideCancellationSummary } from '../utils/ride-cancellation.js';
import { normalizeReferralCode } from '../utils/referral-settlement.js';
import { recordActivity } from '../services/activity-log.js';
import { checkRiderAnalyticsGuard } from '../utils/rider-analytics-guard.js';
import {
  loadPassengerUserForRide,
  RIDE_STATUS_EMAIL_EVENT,
  sendPassengerRideStatusEmail,
} from '../utils/ride-status-email.js';
import { notifyRider } from '../utils/ride-rider-notify.js';
import {
  refundPassengerRideIfPaid,
  resolveRidePaymentMethod,
  formatCancelFeePct,
} from '../utils/ride-refund.js';
import { assertNoPlatformBlockBetweenUsers } from '../utils/platform-blocks.js';

const router = express.Router();

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

// A ride requested more than this many minutes in the future is held (status 'scheduled')
// instead of dispatched immediately — utils/ride-schedule-cron.js flips it to 'pending' and
// actually dispatches once scheduled_at gets this close, giving a driver time to reach pickup.
// A schedule request closer than this window just books/dispatches like "now" — there's no
// point holding a ride 4 minutes out.
export const SCHEDULE_DISPATCH_LEAD_MIN = Number(process.env.RIDE_SCHEDULE_DISPATCH_LEAD_MIN ?? 10);

export function isFutureScheduled(scheduledAt) {
  if (!scheduledAt) return false;
  const at = scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt);
  if (Number.isNaN(at.getTime())) return false;
  return (at.getTime() - Date.now()) > SCHEDULE_DISPATCH_LEAD_MIN * 60 * 1000;
}

const RIDER_ANALYTICS_EVENTS = new Set([
  'page_viewed', 'route_started', 'route_resolved', 'pickup_confidence_shown',
  'pickup_adjusted', 'vehicle_selected', 'confirmation_started', 'confirmation_completed',
  'matching_started', 'matching_expanded', 'matching_delayed', 'matched', 'no_driver',
  'cancelled', 'driver_arrived', 'pickup_verified', 'ride_started', 'ride_completed',
  'rating_submitted', 'book_again',
]);
const RIDER_ANALYTICS_FIELDS = new Set([
  'ride_request_id', 'vehicle_type', 'confidence', 'matching_phase',
  'payment_method', 'price_mode', 'route_resolved', 'elapsed_ms',
]);
const RIDER_ANALYTICS_CATEGORIES = {
  vehicle_type: new Set(['economy', 'comfort', 'premium', 'suv', 'xl', 'accessible']),
  confidence: new Set(['high', 'medium', 'low', 'unknown']),
  matching_phase: new Set(['contacting', 'expanding', 'delayed']),
  payment_method: new Set(['card', 'wallet', 'cash', 'paypal']),
  price_mode: new Set(['standard', 'setprice']),
};
const MAX_ANALYTICS_ELAPSED_MS = 24 * 60 * 60 * 1000;
const MAX_RIDE_STOPS = 5;

function safeRiderAnalyticsMetadata(body) {
  const metadata = {};
  for (const [key, value] of Object.entries(body ?? {})) {
    if (!RIDER_ANALYTICS_FIELDS.has(key)) continue;
    if (RIDER_ANALYTICS_CATEGORIES[key]) {
      if (typeof value !== 'string') continue;
      const normalized = value.trim().toLowerCase();
      if (RIDER_ANALYTICS_CATEGORIES[key].has(normalized)) metadata[key] = normalized;
    } else if (key === 'ride_request_id') {
      const normalized = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
      if (Number.isSafeInteger(normalized) && normalized > 0) metadata[key] = normalized;
    } else if (key === 'route_resolved') {
      if (typeof value === 'boolean') metadata[key] = value;
    } else if (key === 'elapsed_ms') {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_ANALYTICS_ELAPSED_MS) metadata[key] = value;
    }
  }
  return metadata;
}

function rawRideStopsFromBody(body = {}) {
  const raw = body.stops ?? body.ride_stops ?? body.waypoints ?? [];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(raw) ? raw : [];
}

async function normalizeRideStopsForStorage(rawStops = []) {
  const stops = rawStops
    .map((stop, index) => ({
      sequence: Number(stop?.sequence ?? index + 1),
      address: String(stop?.address || stop?.stop_address || stop?.location || '').trim(),
      lat: stop?.lat ?? stop?.latitude ?? null,
      lng: stop?.lng ?? stop?.long ?? stop?.longitude ?? null,
    }))
    .filter((stop) => stop.address)
    .sort((a, b) => a.sequence - b.sequence)
    .slice(0, MAX_RIDE_STOPS);

  const normalized = [];
  for (let index = 0; index < stops.length; index += 1) {
    const stop = stops[index];
    let lat = stop.lat != null && stop.lat !== '' ? Number(stop.lat) : null;
    let lng = stop.lng != null && stop.lng !== '' ? Number(stop.lng) : null;
    if ((lat == null || lng == null) && stop.address) {
      const coords = await geocodeAddress(stop.address);
      if (!coords) {
        const err = new Error('STOP_GEOCODE_FAILED');
        err.stop = stop.address;
        throw err;
      }
      lat = coords.lat;
      lng = coords.lng;
    }
    if (![lat, lng].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      const err = new Error('INVALID_STOP_COORDS');
      err.stop = stop.address;
      throw err;
    }
    normalized.push({
      sequence: index + 1,
      address: stop.address,
      lat,
      lng,
      status: 'pending',
    });
  }
  return normalized;
}

function serializeRideStops(stops = []) {
  return (Array.isArray(stops) ? stops : [])
    .map((stop, index) => ({
      sequence: Number(stop?.sequence ?? index + 1),
      address: String(stop?.address || '').trim(),
      lat: stop?.lat == null ? null : Number(stop.lat),
      lng: stop?.lng == null ? null : Number(stop.lng),
      status: stop?.status || 'pending',
    }))
    .filter((stop) => stop.address)
    .sort((a, b) => a.sequence - b.sequence);
}

async function notifyRideStopChange(io, ride, payload) {
  if (!io || !ride) return;
  if (ride.passenger_id) io.to(`user-${ride.passenger_id}`).emit('ride-stop-change', payload);
  if (ride.assigned_driver_id) {
    const driver = await prisma.driver_profile.findUnique({
      where: { driver_profile_id: ride.assigned_driver_id },
      select: { user_id: true },
    }).catch(() => null);
    if (driver?.user_id) io.to(`user-${driver.user_id}`).emit('ride-stop-change', payload);
  }
}

export async function dispatchCreatedRide(io, result) {
  const onlineDriverCount = await countCanonicalOnlineDrivers(prisma);
  if (onlineDriverCount === 0) {
    await cancelRideRequest(io, result.ride_request_id, result.passenger_id, 'no_driver_available');
    return {
      ok: false,
      status: 503,
      error: 'no_driver_available',
      message: 'No drivers available in your area. Please try again later.',
    };
  }

  let dispatched = await dispatchRideToNextDriver(io, result).catch((err) => {
    console.error('[ride-request] dispatch error:', err.message);
    return null;
  });
  if (!dispatched && onlineDriverCount > 0) {
    dispatched = await dispatchRideToNextDriver(io, result, []).catch(() => null);
  }
  if (!dispatched) {
    await cancelRideRequest(io, result.ride_request_id, result.passenger_id, 'no_driver_available');
    return {
      ok: false,
      status: 503,
      error: 'no_driver_available',
      message: 'No drivers available in your area. Please try again later.',
    };
  }

  const refreshed = await prisma.ride_request.findUnique({
    where: { ride_request_id: result.ride_request_id },
  });
  return { ok: true, ride: refreshed ?? result };
}

/**
 * GET /ride-request/driver/incoming
 * Poll fallback: pending offers assigned to the authenticated driver.
 * In dev (RIDESHARE_BROADCAST_ALL / non-production), includes all pending offers not declined.
 */
router.get('/driver/incoming', authenticateToken, async (req, res) => {
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    let profile = await getCanonicalDriverProfile(prisma, userId);
    if (!profile) {
      profile = await prisma.driver_profile.create({
        data: { user_id: userId, is_online: false, last_ping: new Date() },
      });
    }

    if (profile.is_online !== true) {
      return res.json({
        successful: true,
        data: [],
        broadcast_mode: BROADCAST_ALL_DRIVERS,
        driver_profile_id: profile.driver_profile_id,
        offer_timeout_sec: DRIVER_OFFER_TIMEOUT_SEC,
      });
    }

    const offers = await getIncomingOffersForDriver(profile.driver_profile_id);
    return res.json({
      successful: true,
      data: offers,
      broadcast_mode: BROADCAST_ALL_DRIVERS,
      driver_profile_id: profile.driver_profile_id,
      offer_timeout_sec: DRIVER_OFFER_TIMEOUT_SEC,
    });
  } catch (err) {
    console.error('Driver Incoming Offers Error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * GET /ride-request/drivers/availability
 * Lightweight pre-booking check: are any drivers online?
 */
router.get('/drivers/availability', authenticateToken, async (req, res) => {
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const online_count = await countCanonicalOnlineDrivers(prisma);
    const available = online_count > 0;
    return res.json({
      successful: true,
      data: {
        available,
        online_count,
        message: available
          ? null
          : 'No drivers are online right now. Please try again when a driver is available.',
      },
    });
  } catch (err) {
    console.error('Driver availability check error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * GET /ride-request/nearby?lat=&long=&radius=
 * Returns nearby online drivers sorted by distance ascending.
 */
router.get('/nearby', authenticateToken, async (req, res) => {
  try {
    const { lat, long, radius = 5 } = req.query;
    if (!lat || !long) return res.status(400).json({ successful: false, message: 'lat and long are required' });

    const latVal = Number(lat);
    const longVal = Number(long);
    const latDelta = radius / 111;
    const longDelta = radius / (111 * Math.cos(latVal * (Math.PI / 180)));

    const nearbyDrivers = await prisma.driver_profile.findMany({
      where: {
        is_online: true,
        current_lat: { gte: latVal - latDelta, lte: latVal + latDelta },
        current_long: { gte: longVal - longDelta, lte: longVal + longDelta },
      },
      include: { user: { include: verticalIdentityUserInclude }, vehicle: true },
    });

    // Drivers shown to a passenger display their rideshare vertical identity.
    nearbyDrivers.forEach((d) => applyVerticalIdentity(d.user, 'rideshare'));

    const withDistance = nearbyDrivers
      .map((d) => ({ ...d, distance_km: haversineKm(latVal, longVal, d.current_lat, d.current_long) }))
      .sort((a, b) => a.distance_km - b.distance_km);

    return res.json({ successful: true, data: withDistance });
  } catch (err) {
    console.error('Nearby Drivers Error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * GET /ride-request/estimate?pickup=&drop=&vehicle_type_id=&vehicle_type=
 * Returns fare estimate using FARE_RATES and real distance/duration from the Maps API.
 * Accepts either vehicle_type_id (DB lookup) or vehicle_type name (e.g. "economy").
 */
router.get('/estimate', authenticateToken, async (req, res) => {
  try {
    const { pickup, drop, vehicle_type_id, vehicle_type } = req.query;
    if (!pickup || !drop)
      return res.status(400).json({ successful: false, message: 'pickup and drop are required' });

    // Resolve fare rates from FARE_RATES by name or by DB lookup
    let rates;
    let vehicleTypeName;
    if (vehicle_type) {
      vehicleTypeName = vehicle_type.toLowerCase();
      rates = FARE_RATES[vehicleTypeName];
    }
    if (!rates && vehicle_type_id) {
      const vt = await prisma.vehicle_types.findUnique({ where: { vehicle_type_id: Number(vehicle_type_id) } });
      if (vt) {
        vehicleTypeName = vt.name?.toLowerCase();
        rates = FARE_RATES[vehicleTypeName] ?? FARE_RATES['economy'];
      }
    }
    if (!rates) rates = FARE_RATES['economy'];

    const country = await getCountryFromCoords(pickup);
    const regionData = getRegionData(country);

    let dist_km;
    let duration_min;
    const matrix = await getDistanceMatrix(pickup, drop);
    if (matrix?.distance?.value > 0 && matrix?.duration?.value > 0) {
      dist_km = matrix.distance.value / 1000;
      duration_min = matrix.duration.value / 60;
    } else {
      const p = pickup.split(',').map(Number);
      const d = drop.split(',').map(Number);
      if (p.length === 2 && d.length === 2 && p.every(Number.isFinite) && d.every(Number.isFinite)) {
        dist_km = haversineKm(p[0], p[1], d[0], d[1]);
        duration_min = (dist_km / 30) * 60;
      } else {
        return res.status(422).json({ successful: false, message: 'Could not calculate route. Provide valid addresses or "lat, lng" coordinates.' });
      }
    }

    // Formula: base + (per_km × dist) + (per_min × minutes) + booking_fee + tolls
    const base_fare = rates.base + (rates.per_km * dist_km) + (rates.per_min * duration_min) + rates.booking_fee;
    const governmentTax = parseFloat((base_fare * regionData.tax).toFixed(2));
    const total_fare = parseFloat((base_fare + governmentTax).toFixed(2));

    return res.json({
      successful: true,
      data: {
        country,
        vehicle_type: vehicleTypeName ?? 'economy',
        dist_km: parseFloat(dist_km.toFixed(2)),
        duration_min: Math.round(duration_min),
        base_fare: parseFloat(base_fare.toFixed(2)),
        government_tax: governmentTax,
        total_fare,
        currency: regionData.currency,
      },
    });
  } catch (err) {
    console.error('Estimation Error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * POST /ride-request/fare-estimate
 * Returns fare breakdown for a given vehicle type (economy/comfort/premium/suv).
 * Accepts pickup/dropoff as address strings or "lat, lng" coordinates.
 */
router.post('/fare-estimate', authenticateToken, async (req, res) => {
  try {
    const { pickup, dropoff, vehicle_type } = req.body;
    if (!pickup || !dropoff || !vehicle_type) {
      return res.status(400).json({ successful: false, message: 'pickup, dropoff, and vehicle_type are required' });
    }

    const result = await buildFareEstimateResponse(prisma, {
      pickup,
      dropoff,
      vehicle_type,
      stops: rawRideStopsFromBody(req.body),
    });
    if (!result.ok) {
      return res.status(result.status).json({ successful: false, message: result.message });
    }
    return res.json({ successful: true, ...result.data });
  } catch (err) {
    console.error('Fare Estimate Error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * POST /ride-request/fare-estimates
 * Returns recommended fare breakdown for all vehicle types (one route resolve).
 */
router.post('/fare-estimates', authenticateToken, async (req, res) => {
  try {
    const { pickup, dropoff, pickup_lat, pickup_long, drop_lat, drop_long } = req.body;
    if (!pickup || !dropoff) {
      return res.status(400).json({ successful: false, message: 'pickup and dropoff are required' });
    }

    // Coords the client already geocoded (Google or its own non-Google fallback) — lets the
    // route/fare resolve via Haversine without a server-side geocode call, so this endpoint
    // isn't a hard dependency on Google's Geocoding/Distance Matrix APIs being up.
    const result = await buildAllFareEstimatesResponse({
      pickup,
      dropoff,
      pickup_lat,
      pickup_long,
      drop_lat,
      drop_long,
      stops: rawRideStopsFromBody(req.body),
    });
    if (!result.ok) {
      return res.status(result.status).json({ successful: false, message: result.message });
    }
    return res.json({ successful: true, ...result.data });
  } catch (err) {
    console.error('Fare Estimates Error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/* GET ALL RIDE REQUESTS */
router.get('/', authenticateToken, requireAdmin, async (_req, res) => {
  try {
    const rideRequests = await prisma.ride_request.findMany({
      orderBy: { ride_request_id: 'desc' },
      include: { user: true, vehicle_types: true, active_trip: true, ride_stop: { orderBy: { sequence: 'asc' } } },
    });
    res.json(rideRequests);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch ride requests' });
  }
});

async function fetchPassengerTripHistory(passenger_id, query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(query.limit, 10) || 20));
  const skip = (page - 1) * limit;
  const statusFilter = query.status
    ? String(query.status).toLowerCase().replace('_', '-')
    : null;

  const where = { passenger_id };
  if (statusFilter === 'completed') where.status = 'completed';
  else if (statusFilter === 'cancelled') where.status = 'cancelled';
  else if (statusFilter === 'in-progress') {
    where.status = { in: ['accepted', 'ongoing'] };
  } else if (statusFilter === 'pending') {
    where.status = { in: ['pending', 'pending_payment'] };
  }

  const [rides, totalCount] = await prisma.$transaction([
    prisma.ride_request.findMany({
      where,
      orderBy: { created_at: 'desc' },
      skip,
      take: limit,
      include: {
        vehicle_types: true,
        ride_stop: { orderBy: { sequence: 'asc' } },
        active_trip: {
          orderBy: { trip_id: 'desc' },
          include: {
            driver_profile: {
              include: {
                user: { include: verticalIdentityUserInclude },
                vehicle: { include: { vehicle_types: true } },
              },
            },
            vehicle: { include: { vehicle_types: true } },
            ride_rating: true,
          },
        },
      },
    }),
    prisma.ride_request.count({ where }),
  ]);

  for (const ride of rides) {
    for (const trip of ride.active_trip || []) {
      if (trip.driver_profile?.user) {
        applyVerticalIdentity(trip.driver_profile.user, 'rideshare');
      }
    }
  }

  return {
    data: rides.map(formatPassengerTripHistoryItem),
    pagination: {
      total_records: totalCount,
      current_page: page,
      total_pages: Math.ceil(totalCount / limit) || 0,
      has_more: skip + rides.length < totalCount,
    },
  };
}

/**
 * GET /ride-request/passenger/me
 * Passenger trip history for the authenticated user (order history UI).
 */
router.get('/passenger/me', authenticateToken, async (req, res) => {
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;
    const result = await fetchPassengerTripHistory(userId, req.query);
    return rideOk(res, result);
  } catch (err) {
    console.error('Passenger trip history (me) error:', err);
    return rideFail(res, 500, 'Failed to fetch ride history');
  }
});

/**
 * GET /ride-request/passenger/:passenger_id
 * Passenger trip history for order history UI.
 * Query: page (default 1), limit (default 20, max 50), status (optional filter)
 */
router.get('/passenger/:passenger_id', authenticateToken, async (req, res) => {
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const passenger_id = Number(req.params.passenger_id);
    if (Number.isNaN(passenger_id)) {
      return rideFail(res, 400, 'passenger_id must be a number');
    }
    if (passenger_id !== userId) {
      return rideFail(res, 403, 'Unauthorized action');
    }

    const result = await fetchPassengerTripHistory(passenger_id, req.query);
    return rideOk(res, result);
  } catch (err) {
    console.error('Passenger trip history error:', err);
    return rideFail(res, 500, 'Failed to fetch ride history');
  }
});

router.post('/analytics', authenticateToken, async (req, res) => {
  const userId = requireAuthUserId(req, res);
  if (!userId) return;
  const { event } = req.body ?? {};
  if (!RIDER_ANALYTICS_EVENTS.has(event)) {
    return res.status(400).json({ successful: false, message: 'Unknown rideshare analytics event' });
  }
  const metadata = safeRiderAnalyticsMetadata(req.body);
  const fingerprint = JSON.stringify([event, ...[...RIDER_ANALYTICS_FIELDS].map((key) => metadata[key] ?? null)]);
  const guard = checkRiderAnalyticsGuard(userId, fingerprint);
  if (guard.throttled) {
    return res.set('Retry-After', String(guard.retryAfterSeconds)).status(429).json({
      successful: false,
      message: 'Too many analytics events',
    });
  }
  if (guard.duplicate) return res.status(202).json({ successful: true });
  if (metadata.ride_request_id) {
    const ownedRide = await prisma.ride_request.findFirst({
      where: { ride_request_id: metadata.ride_request_id, passenger_id: userId },
      select: { ride_request_id: true },
    }).catch(() => null);
    if (!ownedRide) delete metadata.ride_request_id;
  }
  try {
    recordActivity(userId, `rideshare.${event}`, { metadata });
  } catch (err) {
    console.error('[ride-request] analytics record failed:', err?.message || err);
  }
  return res.status(202).json({ successful: true });
});

/* GET BY ID — passenger or assigned/active-trip driver only */
router.get('/:ride_request_id', authenticateToken, async (req, res) => {
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const ride_request_id = Number(req.params.ride_request_id);
    if (Number.isNaN(ride_request_id)) return res.status(400).json({ error: 'ride_request_id must be a number' });

    const rideRequest = await prisma.ride_request.findUnique({
      where: { ride_request_id },
      include: {
        user: true,
        vehicle_types: true,
        ride_stop: { orderBy: { sequence: 'asc' } },
        active_trip: {
          include: {
            driver_profile: {
              include: {
                user: true,
                vehicle: { include: { vehicle_types: true } },
              },
            },
            vehicle: { include: { vehicle_types: true } },
            ride_rating: true,
          },
        },
      },
    });

    const denied = await assertCanReadRide(prisma, rideRequest, userId);
    if (denied) {
      return rideFail(res, denied.status, denied.message);
    }

    const currency = rideRequest.user?.currency ?? 'CAD';
    const receipt = buildRideReceiptPayload(rideRequest, null, { currency });
    const cancellation = await buildRideCancellationSummary(rideRequest);

    return rideOk(res, { data: rideRequest, receipt, cancellation });
  } catch (err) {
    console.error(err);
    return rideFail(res, 500, 'Failed to fetch ride request');
  }
});

router.put('/:ride_request_id/stops', authenticateToken, async (req, res) => {
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;
    const ride_request_id = Number(req.params.ride_request_id);
    if (!Number.isInteger(ride_request_id) || ride_request_id <= 0) {
      return rideFail(res, 400, 'Invalid ride_request_id');
    }

    const ride = await prisma.ride_request.findUnique({
      where: { ride_request_id },
      include: { ride_stop: { orderBy: { sequence: 'asc' } } },
    });
    const denied = assertPassengerOwnsRide(ride, userId);
    if (denied) return rideFail(res, denied.status, denied.message);

    const stops = await normalizeRideStopsForStorage(rawRideStopsFromBody(req.body));
    const estimatedFare = await computeEstimatedFare({
      ...ride,
      stops,
      ride_stop: stops,
      offered_fare: null,
    });
    if (estimatedFare == null || estimatedFare < 0.5) {
      throw new Error('STOP_ROUTE_PRICE_FAILED');
    }

    if (['accepted', 'ongoing'].includes(ride.status)) {
      if (!ride.assigned_driver_id) {
        return rideFail(res, 409, 'A driver must be assigned before requesting a driver-approved stop change.');
      }
      const existingPendingChange = await prisma.ride_stop_change.findFirst({
        where: { ride_request_id, status: 'pending' },
        select: { ride_stop_change_id: true },
      });
      if (existingPendingChange) {
        return rideFail(res, 409, 'A stop change is already waiting for driver approval.');
      }
      const previousFare = Number(ride.offered_fare ?? ride.estimated_fare ?? 0);
      const change = await prisma.ride_stop_change.create({
        data: {
          ride_request_id,
          requested_by_user_id: userId,
          driver_profile_id: ride.assigned_driver_id,
          status: 'pending',
          current_stops: serializeRideStops(ride.ride_stop),
          requested_stops: stops,
          previous_estimated_fare: Number.isFinite(previousFare) ? previousFare : null,
          new_estimated_fare: estimatedFare,
          fare_delta: Number((estimatedFare - (Number.isFinite(previousFare) ? previousFare : 0)).toFixed(2)),
        },
      });
      const io = req.app.get('io');
      await notifyRideStopChange(io, ride, {
        ride_request_id,
        change_id: change.ride_stop_change_id,
        status: change.status,
        fare_delta: change.fare_delta,
        new_estimated_fare: change.new_estimated_fare,
        stops,
      });
      return rideOk(res, { data: change, pending_driver_approval: true }, 202);
    }

    if (!['pending_payment', 'scheduled', 'pending'].includes(ride.status)) {
      return rideFail(res, 409, 'Stops can only be changed before a driver accepts, or requested for driver approval during an active ride.');
    }

    const updated = await prisma.$transaction(async (tx) => {
      await tx.ride_stop.deleteMany({ where: { ride_request_id } });
      if (stops.length) {
        await tx.ride_stop.createMany({
          data: stops.map((stop) => ({
            ride_request_id,
            sequence: stop.sequence,
            address: stop.address,
            lat: stop.lat,
            lng: stop.lng,
            status: 'pending',
            added_by_user_id: userId,
          })),
        });
      }
      return tx.ride_request.update({
        where: { ride_request_id },
        data: {
          estimated_fare: estimatedFare,
          offered_fare: null,
        },
        include: { ride_stop: { orderBy: { sequence: 'asc' } } },
      });
    });

    return rideOk(res, { data: updated });
  } catch (err) {
    console.error('[ride stops] update failed:', err);
    if (err.message === 'STOP_GEOCODE_FAILED') {
      return rideFail(res, 422, `Couldn't locate stop address: ${err.stop}`);
    }
    if (err.message === 'INVALID_STOP_COORDS') {
      return rideFail(res, 400, `Invalid coordinates for stop: ${err.stop}`);
    }
    if (err.message === 'STOP_ROUTE_PRICE_FAILED') {
      return rideFail(res, 422, 'Could not calculate a valid fare for the updated stops.');
    }
    return rideFail(res, 500, 'Failed to update ride stops');
  }
});

router.patch('/:ride_request_id/stops/:ride_stop_id/status', authenticateToken, async (req, res) => {
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;
    const ride_request_id = Number(req.params.ride_request_id);
    const ride_stop_id = Number(req.params.ride_stop_id);
    if (!Number.isInteger(ride_request_id) || ride_request_id <= 0 || !Number.isInteger(ride_stop_id) || ride_stop_id <= 0) {
      return rideFail(res, 400, 'Invalid ride or stop id');
    }
    const status = String(req.body?.status || '').toLowerCase();
    if (!['arrived', 'completed'].includes(status)) {
      return rideFail(res, 400, 'Stop status must be arrived or completed');
    }

    const driverProfile = await resolveDriverProfileForUser(prisma, userId, req.body.driver_profile_id);
    if (!driverProfile) return rideFail(res, 403, 'Driver profile not found');
    const ride = await prisma.ride_request.findFirst({
      where: {
        ride_request_id,
        assigned_driver_id: driverProfile.driver_profile_id,
        status: { in: ['accepted', 'ongoing'] },
      },
      select: { ride_request_id: true, passenger_id: true, assigned_driver_id: true },
    });
    if (!ride) return rideFail(res, 403, 'Not your active ride');

    const changed = await prisma.ride_stop.updateMany({
      where: { ride_stop_id, ride_request_id },
      data: {
        status,
        ...(status === 'arrived' ? { arrived_at: new Date() } : { completed_at: new Date() }),
      },
    });
    if (changed.count === 0) return rideFail(res, 404, 'Ride stop not found');
    const updated = await prisma.ride_stop.findUnique({ where: { ride_stop_id } });
    const io = req.app.get('io');
    await notifyRideStopChange(io, ride, {
      ride_request_id,
      type: 'stop_status',
      stop: updated,
    });
    return rideOk(res, { data: updated });
  } catch (err) {
    console.error('[ride stops] status update failed:', err);
    return rideFail(res, 500, 'Failed to update ride stop');
  }
});

router.patch('/:ride_request_id/stop-changes/:ride_stop_change_id', authenticateToken, async (req, res) => {
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;
    const ride_request_id = Number(req.params.ride_request_id);
    const ride_stop_change_id = Number(req.params.ride_stop_change_id);
    if (!Number.isInteger(ride_request_id) || ride_request_id <= 0 || !Number.isInteger(ride_stop_change_id) || ride_stop_change_id <= 0) {
      return rideFail(res, 400, 'Invalid ride or stop-change id');
    }
    const action = String(req.body?.action || req.body?.status || '').toLowerCase();
    if (!['approved', 'rejected'].includes(action)) {
      return rideFail(res, 400, 'Stop change action must be approved or rejected');
    }

    const driverProfile = await resolveDriverProfileForUser(prisma, userId, req.body.driver_profile_id);
    if (!driverProfile) return rideFail(res, 403, 'Driver profile not found');

    const result = await prisma.$transaction(async (tx) => {
      const ride = await tx.ride_request.findFirst({
        where: {
          ride_request_id,
          assigned_driver_id: driverProfile.driver_profile_id,
          status: { in: ['accepted', 'ongoing'] },
        },
        include: { ride_stop: { orderBy: { sequence: 'asc' } }, active_trip: true },
      });
      if (!ride) {
        const err = new Error('NOT_ASSIGNED_DRIVER');
        err.statusCode = 403;
        throw err;
      }
      const change = await tx.ride_stop_change.findFirst({
        where: {
          ride_stop_change_id,
          ride_request_id,
          driver_profile_id: driverProfile.driver_profile_id,
          status: 'pending',
        },
      });
      if (!change) {
        const err = new Error('STOP_CHANGE_NOT_PENDING');
        err.statusCode = 404;
        throw err;
      }
      if (action === 'rejected') {
        const rejected = await tx.ride_stop_change.update({
          where: { ride_stop_change_id },
          data: {
            status: 'rejected',
            rejection_reason: String(req.body?.reason || '').trim().slice(0, 255) || null,
            decided_at: new Date(),
          },
        });
        return { ride, change: rejected, stops: ride.ride_stop };
      }

      const requestedStops = serializeRideStops(change.requested_stops);
      await tx.ride_stop.deleteMany({ where: { ride_request_id } });
      if (requestedStops.length) {
        await tx.ride_stop.createMany({
          data: requestedStops.map((stop) => ({
            ride_request_id,
            sequence: stop.sequence,
            address: stop.address,
            lat: stop.lat,
            lng: stop.lng,
            status: 'pending',
            added_by_user_id: change.requested_by_user_id,
            driver_approved_at: new Date(),
          })),
        });
      }
      const approved = await tx.ride_stop_change.update({
        where: { ride_stop_change_id },
        data: { status: 'approved', decided_at: new Date() },
      });
      await tx.ride_request.update({
        where: { ride_request_id },
        data: {
          estimated_fare: change.new_estimated_fare,
          offered_fare: null,
        },
      });
      await tx.active_trip.updateMany({
        where: { request_id: ride_request_id, ended_at: null },
        data: { total_fare: change.new_estimated_fare },
      });
      const updatedStops = await tx.ride_stop.findMany({
        where: { ride_request_id },
        orderBy: { sequence: 'asc' },
      });
      return { ride, change: approved, stops: updatedStops };
    });

    const io = req.app.get('io');
    await notifyRideStopChange(io, result.ride, {
      ride_request_id,
      change_id: result.change.ride_stop_change_id,
      status: result.change.status,
      fare_delta: result.change.fare_delta,
      new_estimated_fare: result.change.new_estimated_fare,
      stops: result.stops,
    });
    return rideOk(res, { data: result.change, stops: result.stops });
  } catch (err) {
    console.error('[ride stops] change decision failed:', err);
    return rideFail(res, err.statusCode || 500, err.statusCode ? err.message : 'Failed to update ride stop change');
  }
});

const VEHICLE_TYPE_DEFAULTS = {
  economy: { base_rate_per_km: 0.85 },
  comfort: { base_rate_per_km: 1.10 },
  premium: { base_rate_per_km: 1.80 },
  suv: { base_rate_per_km: 1.40 },
  xl: { base_rate_per_km: 1.60 },
  accessible: { base_rate_per_km: 0.90 },
};

/**
 * POST /ride-request
 * Creates a ride request and auto-notifies the nearest available driver.
 * Accepts either:
 *   - { pickup_lat, pickup_long, pickup_address, drop_lat, drop_long, drop_address, requested_type_id }
 *   - { pickup_address, drop_address, vehicle_type } (address strings + type name — coords geocoded server-side)
 */
router.post('/', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    let { pickup_lat, pickup_long, drop_lat, drop_long, pickup_address, drop_address, requested_type_id, vehicle_type, offered_price } = req.body;
    const orderReferralCode = normalizeReferralCode(req.body.referral_code);

    let scheduledAt = null;
    if (req.body.scheduled_at != null && req.body.scheduled_at !== '') {
      const parsed = new Date(req.body.scheduled_at);
      if (Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ successful: false, message: 'Invalid scheduled_at date/time' });
      }
      if (parsed.getTime() <= Date.now()) {
        return res.status(400).json({ successful: false, message: 'scheduled_at must be in the future' });
      }
      scheduledAt = parsed;
    }

    // Normalise field names sent by the frontend (pickup_location / dropoff_location → addresses)
    if (!pickup_address && req.body.pickup_location) pickup_address = req.body.pickup_location;
    if (!drop_address && req.body.dropoff_location) drop_address = req.body.dropoff_location;
    if (!vehicle_type && req.body.vehicle_type) vehicle_type = req.body.vehicle_type;

    if (!pickup_address || !drop_address)
      return res.status(400).json({ successful: false, message: 'pickup_address and drop_address are required' });

    const rideStops = await normalizeRideStopsForStorage(rawRideStopsFromBody(req.body));

    // If coords not provided, geocode the addresses. A failed geocode used to silently fall
    // back to (0, 0) — the ride would still get created and charged, then fail dispatch far
    // downstream with a misleading "no drivers available" (drivers were searched near Null
    // Island instead of the real pickup). Fail fast here instead, before any payment is taken.
    if (pickup_lat == null || pickup_long == null) {
      const coords = await geocodeAddress(pickup_address);
      if (!coords) {
        return res.status(422).json({
          successful: false,
          error: 'geocode_failed',
          message: "Couldn't locate your pickup address. Try being more specific.",
        });
      }
      pickup_lat = coords.lat; pickup_long = coords.lng;
    }
    if (drop_lat == null || drop_long == null) {
      const coords = await geocodeAddress(drop_address);
      if (!coords) {
        return res.status(422).json({
          successful: false,
          error: 'geocode_failed',
          message: "Couldn't locate your drop-off address. Try being more specific.",
        });
      }
      drop_lat = coords.lat; drop_long = coords.lng;
    }

    // Resolve vehicle type ID — look up by name, upsert if missing
    if (!requested_type_id && vehicle_type) {
      const name = vehicle_type.toLowerCase();
      let vt = await prisma.vehicle_types.findFirst({ where: { name } });
      if (!vt) {
        const defaults = VEHICLE_TYPE_DEFAULTS[name] ?? { base_rate_per_km: 1.00 };
        vt = await prisma.vehicle_types.create({ data: { name, ...defaults } });
      }
      requested_type_id = vt.vehicle_type_id;
    }

    if (!requested_type_id)
      return res.status(400).json({ successful: false, message: 'vehicle_type or requested_type_id is required' });

    // Resolve the type name for quote-hashing even if the caller only sent requested_type_id.
    let resolvedVehicleTypeName = vehicle_type ? String(vehicle_type).toLowerCase() : null;
    if (!resolvedVehicleTypeName) {
      const vt = await prisma.vehicle_types.findUnique({ where: { vehicle_type_id: Number(requested_type_id) } });
      resolvedVehicleTypeName = vt?.name ? String(vt.name).toLowerCase() : null;
    }

    const customFare =
      offered_price != null && offered_price !== '' ? Number(offered_price) : null;

    if (customFare != null && (Number.isNaN(customFare) || customFare < 1)) {
      return res.status(400).json({
        successful: false,
        message: 'Offered price must be at least $1.00',
      });
    }

    let estimatedFare = customFare;
    if (estimatedFare == null) {
      estimatedFare = await computeEstimatedFare({
        pickup_address,
        drop_address,
        pickup_lat: Number(pickup_lat),
        pickup_long: Number(pickup_long),
        drop_lat: Number(drop_lat),
        drop_long: Number(drop_long),
        stops: rideStops,
        requested_type_id: Number(requested_type_id),
        vehicle_type: vehicle_type ? String(vehicle_type).toLowerCase() : undefined,
        offered_fare: null,
      });
    }

    if (estimatedFare == null || estimatedFare < 0.5) {
      return res.status(400).json({
        successful: false,
        message: 'Could not calculate a valid fare for this trip. Check pickup and dropoff addresses.',
      });
    }

    // Locked-quote disclosure: if booking off a fare-estimate quote, make sure the price
    // hasn't drifted since it was shown. A stale/invalid/mismatched quote returns a fresh
    // one instead of silently booking (and later charging) a different number than what
    // the rider saw. Requests with no quote_id (older clients, set-your-own-price) skip
    // this and keep today's behavior.
    if (customFare == null && req.body.quote_id) {
      const quoteInputs = rideQuoteInputs({
        pickup_address,
        drop_address,
        vehicle_type: resolvedVehicleTypeName,
        stops: rideStops,
      });
      const quoteCheck = verifyQuote(req.body.quote_id, quoteInputs);
      const amountDrifted = quoteCheck.ok && Math.abs(quoteCheck.amount - estimatedFare) > 0.02;
      if (!quoteCheck.ok || amountDrifted) {
        const fresh = signQuote(estimatedFare, quoteInputs);
        return res.status(409).json({
          successful: false,
          error: 'quote_expired',
          message: quoteCheck.ok ? 'The price has changed since you last checked.' : quoteCheck.error,
          fresh_quote: { amount: estimatedFare, quote_id: fresh.quote_id, quote_expires_at: fresh.expires_at },
        });
      }
    }

    const fareCheck = validateChargeAmount(estimatedFare);
    if (!fareCheck.ok) {
      return res.status(fareCheck.status).json({ successful: false, message: fareCheck.error });
    }

    const awaitPayment = req.body.await_payment === true || req.body.await_payment === 'true';
    // A ride scheduled well into the future is held rather than dispatched now, so today's
    // driver supply is irrelevant to whether the booking itself can be made.
    const futureScheduled = isFutureScheduled(scheduledAt);

    if (!futureScheduled) {
      const onlineDriverCount = await countCanonicalOnlineDrivers(prisma);
      if (onlineDriverCount === 0) {
        return res.status(503).json({
          successful: false,
          error: 'no_driver_available',
          message: 'No drivers available in your area. Please try again later.',
        });
      }
    }

    const initialOfferExpiresAt = (awaitPayment || futureScheduled)
      ? null
      : new Date(Date.now() + DRIVER_OFFER_TIMEOUT_SEC * 1000);

    const { ride: createdRide, releasedRideIds } = await prisma.$transaction(async (tx) => {
      const vehicleTypeExists = await tx.vehicle_types.findUnique({ where: { vehicle_type_id: Number(requested_type_id) } });
      if (!vehicleTypeExists) throw new Error('Invalid vehicle type selected.');

      const releasedRideIds = await releasePassengerBlockingRequests(tx, userId);

      const ride = await tx.ride_request.create({
        data: {
          passenger_id: userId,
          pickup_lat: Number(pickup_lat), pickup_long: Number(pickup_long), pickup_address,
          drop_lat: Number(drop_lat), drop_long: Number(drop_long), drop_address,
          requested_type_id: Number(requested_type_id),
          offered_fare: customFare,
          estimated_fare: estimatedFare,
          offer_expires_at: initialOfferExpiresAt,
          scheduled_at: scheduledAt,
          status: awaitPayment ? 'pending_payment' : (futureScheduled ? 'scheduled' : 'pending'),
          created_at: new Date(),
          referral_code: orderReferralCode,
        },
      });
      if (rideStops.length) {
        await tx.ride_stop.createMany({
          data: rideStops.map((stop) => ({
            ride_request_id: ride.ride_request_id,
            sequence: stop.sequence,
            address: stop.address,
            lat: stop.lat,
            lng: stop.lng,
            status: stop.status,
            added_by_user_id: userId,
          })),
        });
      }
      const withStops = rideStops.length
        ? await tx.ride_request.findUnique({
          where: { ride_request_id: ride.ride_request_id },
          include: { ride_stop: { orderBy: { sequence: 'asc' } } },
        })
        : ride;
      return { ride: withStops, releasedRideIds };
    });

    for (const releasedId of releasedRideIds) {
      await refundPassengerRideIfPaid({
        rideRequestId: releasedId,
        passengerId: userId,
        reason: 'replaced_by_new_booking',
      }).catch((e) => console.error(`[ride-request] refund released ride #${releasedId} failed:`, e.message));
    }

    const result = createdRide;

    if (awaitPayment || futureScheduled) {
      return res.status(201).json({ successful: true, data: result });
    }

    const dispatchResult = await dispatchCreatedRide(io, result);
    if (!dispatchResult.ok) {
      return res.status(dispatchResult.status).json({
        successful: false,
        error: dispatchResult.error,
        message: dispatchResult.message,
      });
    }

    return res.status(201).json({ successful: true, data: dispatchResult.ride });
  } catch (err) {
    console.error('Ride Request Error:', err);
    if (err.message === 'STOP_GEOCODE_FAILED') {
      return res.status(422).json({
        successful: false,
        error: 'stop_geocode_failed',
        message: `Couldn't locate stop address: ${err.stop}`,
      });
    }
    if (err.message === 'INVALID_STOP_COORDS') {
      return res.status(400).json({
        successful: false,
        error: 'invalid_stop_coordinates',
        message: `Invalid coordinates for stop: ${err.stop}`,
      });
    }
    if (err.message === 'You already have a pending ride request.') {
      return rideFail(res, 409, err.message, { code: 'RIDE_PENDING' });
    }
    if (err.code === 'RIDE_IN_PROGRESS') {
      return rideFail(res, 409, err.message || 'You already have a ride in progress.', { code: 'RIDE_IN_PROGRESS' });
    }
    if (err.code === 'P2022' || /Unknown column|estimated_fare|assigned_driver_id|offer_expires_at/.test(String(err.message))) {
      return res.status(500).json({
        successful: false,
        message: 'Database schema out of date. Run: npx prisma db push (local) on the backend.',
      });
    }
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * POST /ride-request/:ride_request_id/confirm-payment
 * After card/PayPal/wallet payment, start driver dispatch for a held ride.
 */
router.post('/:ride_request_id/confirm-payment', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const ride_request_id = Number(req.params.ride_request_id);
    if (!ride_request_id || Number.isNaN(ride_request_id)) {
      return res.status(400).json({ successful: false, message: 'Invalid ride_request_id' });
    }

    const { payment_method, payment_intent_id } = req.body;

    const ride = await prisma.ride_request.findUnique({ where: { ride_request_id } });
    const denied = assertPassengerOwnsRide(ride, userId);
    if (denied) return res.status(denied.status).json({ successful: false, message: denied.message });
    // Idempotent retry — confirm-payment already advanced this ride past the hold.
    if (['scheduled', 'pending', 'accepted', 'ongoing', 'completed'].includes(ride.status)) {
      return res.json({ successful: true, data: ride, message: 'Payment already confirmed' });
    }
    // The hold was cancelled/expired out from under the payment (e.g. a concurrent
    // re-booking cleaned it up). For card the charge was already captured client-side,
    // so refund it rather than stranding the rider's money with no ride.
    if (ride.status !== 'pending_payment') {
      if (payment_method === 'card' && payment_intent_id && stripe) {
        try {
          const lostPi = await stripe.paymentIntents.retrieve(payment_intent_id);
          if (
            lostPi.status === 'succeeded' &&
            lostPi.metadata?.ride_request_id === String(ride_request_id) &&
            lostPi.metadata?.user_id === String(userId)
          ) {
            await stripe.refunds.create({ payment_intent: payment_intent_id });
          }
        } catch (refundErr) {
          console.error('confirm-payment refund-on-lost-hold failed:', refundErr.message);
        }
      }
      return res.status(409).json({
        successful: false,
        message: 'This ride is no longer awaiting payment. Any payment made has been refunded.',
      });
    }

    // A future-scheduled ride is held rather than dispatched now, so today's driver supply
    // doesn't gate whether the (already-in-progress) payment can be confirmed.
    if (!isFutureScheduled(ride.scheduled_at) && await countCanonicalOnlineDrivers(prisma) === 0) {
      if (payment_method === 'card' && payment_intent_id && stripe) {
        try {
          const pi = await stripe.paymentIntents.retrieve(payment_intent_id);
          if (
            pi.status === 'succeeded' &&
            pi.metadata?.ride_request_id === String(ride_request_id) &&
            pi.metadata?.user_id === String(userId)
          ) {
            await stripe.refunds.create({ payment_intent: payment_intent_id });
          }
        } catch (refundErr) {
          console.error('confirm-payment refund-no-drivers failed:', refundErr.message);
          return res.status(503).json({
            successful: false,
            error: 'refund_failed',
            message: 'Refund failed, ride not cancelled. Please retry.',
          });
        }
      }
      await cancelRideRequest(io, ride_request_id, userId, 'no_driver_available');
      return res.status(503).json({
        successful: false,
        error: 'no_driver_available',
        message: 'No drivers are online right now. Please try again when a driver is available.',
      });
    }

    const expectedCharge = getExpectedChargeForRide(ride);
    const chargeCheck = validateChargeAmount(expectedCharge, { ride });
    if (!chargeCheck.ok) {
      return res.status(chargeCheck.status).json({ successful: false, message: chargeCheck.error });
    }

    // The status transition pending_payment -> pending is the concurrency/idempotency gate:
    // a single atomic updateMany claims the ride so two concurrent confirm-payment calls can
    // never both proceed (and, on the wallet path, never both debit). offer_expires_at is set
    // by the claim itself.
    const offerExpiresAt = new Date(Date.now() + DRIVER_OFFER_TIMEOUT_SEC * 1000);

    if (payment_method === 'card') {
      if (!stripe) return res.status(503).json({ successful: false, message: 'Stripe not configured' });
      if (!payment_intent_id) {
        return res.status(400).json({ successful: false, message: 'payment_intent_id is required for card payments' });
      }
      const pi = await stripe.paymentIntents.retrieve(payment_intent_id);
      if (pi.metadata?.user_id !== String(userId)) {
        return res.status(403).json({ successful: false, message: 'Payment does not belong to this user' });
      }
      if (pi.metadata?.ride_request_id !== String(ride_request_id)) {
        return res.status(400).json({ successful: false, message: 'Payment is not linked to this ride' });
      }
      if (pi.status !== 'succeeded') {
        return res.status(400).json({ successful: false, message: 'Payment has not completed successfully' });
      }
      const paid = pi.amount / 100;
      if (Math.abs(paid - chargeCheck.amount) > 0.02) {
        return res.status(400).json({ successful: false, message: 'Paid amount does not match ride fare' });
      }
      // Card PI is idempotent (one PI = one charge); just claim the ride atomically.
      const claim = await prisma.ride_request.updateMany({
        where: { ride_request_id, status: 'pending_payment' },
        data: { status: 'pending', offer_expires_at: offerExpiresAt },
      });
      if (claim.count === 0) {
        const r = await prisma.ride_request.findUnique({ where: { ride_request_id } });
        return res.json({ successful: true, data: r, message: 'Payment already confirmed' });
      }
    } else if (payment_method === 'paypal') {
      // PayPal capture is not verifiable server-side yet (sandbox/deferred). Accepting it
      // here would dispatch a ride on an unverified client-supplied order id. Reject until
      // capture verification + refund is implemented; create-order is also disabled so the
      // rider never captures. Card and wallet are the supported methods.
      return res.status(503).json({
        successful: false,
        message: 'PayPal is temporarily unavailable. Please pay by card or wallet.',
      });
    } else if (payment_method === 'wallet') {
      let wallet = await prisma.strug_wallet.findUnique({ where: { user_id: userId } });
      if (!wallet) {
        wallet = await prisma.strug_wallet.create({ data: { user_id: userId, balance: 0, currency: 'CAD' } });
      }
      if (wallet.status === 'frozen') {
        return res.status(402).json({ successful: false, message: 'Your wallet is frozen and cannot be used for payment.' });
      }
      if (wallet.currency && wallet.currency !== 'CAD') {
        return res.status(409).json({
          successful: false,
          message: `Your wallet is in ${wallet.currency}. Rideshare is billed in CAD — please pay by card.`,
        });
      }
      // Claim + debit in ONE transaction, claim-first:
      //  - claim (pending_payment -> pending) serializes confirm-payment for this ride, so two
      //    concurrent wallet calls can't both reach the debit (fixes the double-debit race);
      //  - the `balance >= amount` guard lives in the debit's WHERE clause (no DB balance>=0
      //    constraint to fall back on);
      //  - money move + ride-state advance commit together, so a crash can't leave the rider
      //    charged-but-not-dispatched (fixes the partial-failure window).
      const INSUFFICIENT = 'INSUFFICIENT_FUNDS';
      let outcome;
      try {
        outcome = await prisma.$transaction(async (tx) => {
          const claim = await tx.ride_request.updateMany({
            where: { ride_request_id, status: 'pending_payment' },
            data: { status: 'pending', offer_expires_at: offerExpiresAt },
          });
          if (claim.count === 0) return 'already_confirmed';
          const dec = await tx.strug_wallet.updateMany({
            where: { user_id: userId, currency: 'CAD', balance: { gte: chargeCheck.amount } },
            data: { balance: { decrement: chargeCheck.amount } },
          });
          if (dec.count === 0) throw new Error(INSUFFICIENT); // rolls back the claim
          await tx.wallet_transaction.create({
            data: {
              user_id: userId,
              amount: -chargeCheck.amount,
              type: 'debit',
              source: 'rideshare_payment',
              description: `Rideshare booking #${ride_request_id}`,
            },
          });
          return 'ok';
        });
      } catch (e) {
        if (e.message === INSUFFICIENT) {
          const fresh = await prisma.strug_wallet.findUnique({ where: { user_id: userId } });
          const bal = fresh ? parseFloat(fresh.balance) : 0;
          return res.status(402).json({
            successful: false,
            message: `Insufficient wallet balance. You have $${bal.toFixed(2)} but $${chargeCheck.amount.toFixed(2)} is required.`,
          });
        }
        throw e;
      }
      if (outcome === 'already_confirmed') {
        const r = await prisma.ride_request.findUnique({ where: { ride_request_id } });
        return res.json({ successful: true, data: r, message: 'Payment already confirmed' });
      }
    } else {
      return res.status(400).json({ successful: false, message: 'payment_method must be card, paypal, or wallet' });
    }

    const updated = await prisma.ride_request.findUnique({ where: { ride_request_id } });

    // The claim above always advances pending_payment -> pending (that transition is the
    // concurrency gate, see comment above). A future-scheduled ride now gets held instead of
    // dispatched immediately — this adjustment happens as a separate, non-concurrency-critical
    // step after the claim, so it doesn't touch the claim's idempotency guarantees.
    if (isFutureScheduled(updated.scheduled_at)) {
      const scheduled = await prisma.ride_request.update({
        where: { ride_request_id },
        data: { status: 'scheduled', offer_expires_at: null },
      });
      return res.json({ successful: true, data: scheduled, message: 'Ride scheduled' });
    }

    const dispatchResult = await dispatchCreatedRide(io, updated);
    if (!dispatchResult.ok) {
      return res.status(dispatchResult.status).json({
        successful: false,
        error: dispatchResult.error,
        message: `${dispatchResult.message} Your payment has been refunded.`,
      });
    }

    return res.json({ successful: true, data: dispatchResult.ride });
  } catch (err) {
    console.error('confirm-payment error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * PUT /ride-request/:ride_request_id/decline
 * Driver declines — find and notify next nearest driver.
 */
router.put('/:ride_request_id/decline', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const ride_request_id = Number(req.params.ride_request_id);

    const driverProfile = await resolveDriverProfileForUser(prisma, userId, req.body.driver_profile_id);
    if (!driverProfile) {
      return res.status(403).json({ successful: false, message: 'Unauthorized action' });
    }
    const driver_profile_id = driverProfile.driver_profile_id;

    const ride = await prisma.ride_request.findUnique({ where: { ride_request_id } });
    if (!ride) return res.status(404).json({ successful: false, message: 'Ride not found' });
    if (ride.status !== 'pending') return res.status(400).json({ successful: false, message: 'Ride is no longer pending' });

    if (!BROADCAST_ALL_DRIVERS && ride.assigned_driver_id && ride.assigned_driver_id !== driver_profile_id) {
      return res.status(403).json({ successful: false, message: 'This offer is assigned to another driver' });
    }

    const result = await reofferRideAfterDecline(io, ride_request_id, driver_profile_id, userId);

    if (result.cancelled) {
      return res.json({ successful: true, message: 'Declined — no more drivers available', reoffered: false });
    }
    if (result.reoffered) {
      return res.json({ successful: true, message: 'Declined — offer sent to next driver(s)', reoffered: true });
    }
    return res.json({
      successful: true,
      message: 'Declined — re-offering to other drivers shortly',
      reoffered: false,
      pending_redispatch: true,
    });
  } catch (err) {
    console.error('Decline Ride Error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/* PUT /ride-request/:ride_request_id/cancel */
router.put('/:ride_request_id/cancel', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const ride_request_id = Number(req.params.ride_request_id);

    const existingRide = await prisma.ride_request.findUnique({ where: { ride_request_id } });
    if (!existingRide) return res.status(404).json({ successful: false, message: 'Ride request not found' });

    const denied = assertPassengerOwnsRide(existingRide, userId);
    if (denied) return res.status(denied.status).json({ successful: false, message: denied.message });

    const cancelErr = assertCanCancelRide(existingRide);
    if (cancelErr) return res.status(cancelErr.status).json({ successful: false, message: cancelErr.message });

    const { refund } = await cancelRideRequest(
      io,
      ride_request_id,
      existingRide.passenger_id,
      'cancelled_by_passenger',
    );

    let message = 'Ride cancelled successfully';
    if (refund?.refunded) {
      if (refund.cancel_fee > 0) {
        message = `Ride cancelled. A ${formatCancelFeePct(refund.cancel_fee, refund.paid_amount)}% cancellation fee ($${Number(refund.cancel_fee).toFixed(2)}) was applied. $${Number(refund.amount).toFixed(2)} refunded.`;
      } else {
        message = `Ride cancelled. $${Number(refund.amount).toFixed(2)} refunded to your wallet or card.`;
      }
    }

    return res.json({ successful: true, message, refund: refund ?? null });
  } catch (err) {
    console.error('Cancel Ride Error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/* PUT /ride-request/:ride_request_id/accept */
router.put('/:ride_request_id/accept', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const ride_request_id = Number(req.params.ride_request_id);
    if (!ride_request_id || Number.isNaN(ride_request_id)) {
      return res.status(400).json({ successful: false, message: 'Invalid ride_request_id' });
    }

    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const otp = crypto.randomInt(100000, 1000000).toString();

    let driverProfile = await resolveDriverProfileForUser(prisma, userId, req.body.driver_profile_id, {
      user: true,
      vehicle: { include: { vehicle_types: true } },
    });

    if (!driverProfile) {
      return res.status(403).json({
        successful: false,
        message: 'Driver profile not found. Go online from the dashboard first.',
      });
    }

    const driver_profile_id = driverProfile.driver_profile_id;
    if (!driverProfile.is_online) {
      return res.status(403).json({
        successful: false,
        message: 'You must be online to accept ride requests.',
      });
    }
    const vehicle = Array.isArray(driverProfile.vehicle) ? driverProfile.vehicle[0] : null;
    const vehicleId = req.body.vehicle_id ?? vehicle?.vehicle_id ?? null;

    const pendingRide = await prisma.ride_request.findUnique({
      where: { ride_request_id },
      include: { ride_stop: { orderBy: { sequence: 'asc' } } },
    });
    if (!pendingRide) return res.status(404).json({ successful: false, message: 'Ride not found' });

    const acceptErr = assertCanAcceptRide(pendingRide);
    if (acceptErr) return res.status(acceptErr.status).json({ successful: false, message: acceptErr.message });
    await assertNoPlatformBlockBetweenUsers(userId, pendingRide.passenger_id);
    if ((pendingRide.declined_driver_ids || []).includes(driver_profile_id)) {
      return res.status(403).json({ successful: false, message: 'You already declined this ride' });
    }
    if (
      !BROADCAST_ALL_DRIVERS &&
      pendingRide.assigned_driver_id &&
      pendingRide.assigned_driver_id !== driver_profile_id
    ) {
      return res.status(403).json({ successful: false, message: 'This offer is assigned to another driver' });
    }

    const acceptWhere = {
      ride_request_id,
      status: 'pending',
      NOT: { declined_driver_ids: { has: driver_profile_id } },
      ...(BROADCAST_ALL_DRIVERS ? {} : { assigned_driver_id: driver_profile_id }),
    };

    const trip = await prisma.$transaction(async (tx) => {
      const updatedRide = await tx.ride_request.updateMany({
        where: acceptWhere,
        data: {
          status: 'accepted',
          assigned_driver_id: driver_profile_id,
          offer_expires_at: null,
        },
      });
      if (updatedRide.count === 0) throw new Error('ALREADY_ACCEPTED');

      // Feeds the acceptance-rate factor in ride-dispatch's driver scoring — drivers who
      // reliably accept offers rank higher; explicit declines/timeouts count against them.
      await tx.driver_profile.update({
        where: { driver_profile_id },
        data: { accept_count: { increment: 1 } },
      });

      return tx.active_trip.create({
        data: {
          otp_code: otp,
          accepted_at: new Date(),
          request_id: ride_request_id,
          driver_id: driver_profile_id,
          total_fare: pendingRide.offered_fare ?? pendingRide.estimated_fare ?? null,
          ...(vehicleId ? { vehicle_id: Number(vehicleId) } : {}),
        },
      });
    });

    const payment_method = await resolveRidePaymentMethod(pendingRide.passenger_id, ride_request_id);
    await prisma.active_trip.update({
      where: { trip_id: trip.trip_id },
      data: { payment_method },
    });

    const vehicleTypeName = vehicle?.vehicle_types?.name ?? vehicle?.model ?? 'Vehicle';
    const plate = vehicle?.plate_number ?? '---';

    const acceptPayload = {
      message: 'Driver is on the way!',
      trip_id: trip.trip_id,
      otp,
      driver: {
        id: driver_profile_id,
        name: driverProfile.user?.name ?? 'Your Driver',
        rating: driverProfile.rating ?? 4.8,
        vehicle_type: vehicleTypeName,
        plate,
        eta: '~5 min',
      },
    };

    if (pendingRide.passenger_id) {
      io.to(`user-${pendingRide.passenger_id}`).emit(`ride-accepted-${ride_request_id}`, acceptPayload);
      // Durable + push twin of the tracking-screen socket event above.
      notifyRider(io, 'accepted', {
        passengerId: pendingRide.passenger_id,
        actorUserId: driverProfile.user?.user_id ?? null,
        rideRequestId: ride_request_id,
        tripId: trip.trip_id,
        body: `${driverProfile.user?.name ?? 'Your driver'} · ${vehicleTypeName} · ${plate}`,
        data: { otp, eta: '~5 min', driver_name: driverProfile.user?.name ?? null, vehicle_type: vehicleTypeName, plate },
      });
    }

    try {
      const passenger = await loadPassengerUserForRide(prisma, pendingRide.passenger_id);
      await sendPassengerRideStatusEmail(RIDE_STATUS_EMAIL_EVENT.ASSIGNED, {
        passengerUser: passenger,
        ride: pendingRide,
        trip,
        driverName: driverProfile.user?.name ?? 'Your Driver',
        vehicleType: vehicleTypeName,
        plate,
        eta: '~5 min',
      });
    } catch (emailErr) {
      console.error('[accept ride] assigned email failed:', emailErr.message);
    }

    await notifyOfferClosedToDrivers(io, ride_request_id, driver_profile_id);

    try {
      const { syncRideChatMembers } = await import('../services/chat-context-service.js');
      await syncRideChatMembers(ride_request_id);
    } catch (chatErr) {
      console.error('Ride chat member sync failed:', chatErr.message);
    }

    return res.json({
      successful: true,
      message: 'Ride accepted successfully',
      data: { trip_id: trip.trip_id, otp, driver_profile_id },
    });
  } catch (err) {
    console.error('Accept Ride Error:', err);
    if (err.message === 'ALREADY_ACCEPTED') {
      return rideFail(res, 409, 'This ride has already been accepted by another driver.', { code: 'ALREADY_ACCEPTED' });
    }
    if (err.statusCode) {
      return res.status(err.statusCode).json({ successful: false, message: err.message || 'This ride is not available.' });
    }
    if (err.code === 'P2003') {
      return res.status(400).json({ successful: false, message: 'Driver profile or vehicle is invalid. Complete your driver profile and try again.' });
    }
    return res.status(500).json({ successful: false, message: clientErrorMessage(err) });
  }
});

/* PUT /ride-request/:ride_request_id (generic update) */
router.put('/:ride_request_id', authenticateToken, async (req, res) => {
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const ride_request_id = Number(req.params.ride_request_id);
    if (Number.isNaN(ride_request_id)) return res.status(400).json({ error: 'ride_request_id must be a number' });

    const existing = await prisma.ride_request.findUnique({ where: { ride_request_id } });
    if (!existing) return res.status(404).json({ error: 'Ride request not found' });

    const denied = assertPassengerOwnsRide(existing, userId);
    if (denied) return res.status(denied.status).json({ successful: false, message: denied.message });

    const modifyErr = assertCanModifyRide(existing);
    if (modifyErr) return res.status(modifyErr.status).json({ successful: false, message: modifyErr.message });

    const { pickup_lat, pickup_long, pickup_address, drop_lat, drop_long, drop_address, requested_type_id, created_at } = req.body;

    const updated = await prisma.ride_request.update({
      where: { ride_request_id },
      data: {
        pickup_lat: pickup_lat ?? existing.pickup_lat,
        pickup_long: pickup_long ?? existing.pickup_long,
        pickup_address: pickup_address ?? existing.pickup_address,
        drop_lat: drop_lat ?? existing.drop_lat,
        drop_long: drop_long ?? existing.drop_long,
        drop_address: drop_address ?? existing.drop_address,
        requested_type_id: requested_type_id ?? existing.requested_type_id,
        created_at: created_at ? new Date(created_at) : existing.created_at,
      },
      include: { user: true, vehicle_types: true, active_trip: true },
    });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update ride request' });
  }
});

/**
 * @deprecated Use PATCH /active-trip/:trip_id/verify-otp (canonical).
 * Kept for backward compatibility with older clients.
 */
router.patch('/:trip_id/verify-otp', authenticateToken, async (req, res) => {
  const io = req.app.get('io');
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const trip_id = Number(req.params.trip_id);
    const { otp } = req.body;
    const result = await verifyTripOtpAndStart(prisma, io, trip_id, otp, userId);
    if (result.error) {
      return res.status(result.error.status).json({ successful: false, message: result.error.message });
    }
    return res.json({ successful: true, message: result.message, already_started: !!result.alreadyStarted });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/* DELETE */
router.delete('/:ride_request_id', authenticateToken, async (req, res) => {
  try {
    const userId = requireAuthUserId(req, res);
    if (!userId) return;

    const ride_request_id = Number(req.params.ride_request_id);
    if (Number.isNaN(ride_request_id)) return res.status(400).json({ error: 'ride_request_id must be a number' });

    const existing = await prisma.ride_request.findUnique({ where: { ride_request_id } });
    if (!existing) return res.status(404).json({ error: 'Ride request not found' });

    const denied = assertPassengerOwnsRide(existing, userId);
    if (denied) return res.status(denied.status).json({ successful: false, message: denied.message });

    const modifyErr = assertCanModifyRide(existing);
    if (modifyErr) return res.status(modifyErr.status).json({ successful: false, message: modifyErr.message });

    await prisma.ride_request.delete({ where: { ride_request_id } });
    res.json({ message: 'Ride request deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete ride request' });
  }
});

export default router;
