import prisma from './prisma-client.js';
import { geocodeAddress, getDistanceMatrix } from './google-maps.js';
import { signQuote } from './price-quote.js';

/** Inputs a rideshare quote is locked against — same shape at quote time and at booking time. */
export function rideQuoteInputs({ pickup_address, drop_address, vehicle_type, stops = [] }) {
  return {
    v: 'ride',
    pickup_address: String(pickup_address || '').trim().toLowerCase(),
    drop_address: String(drop_address || '').trim().toLowerCase(),
    stops: normalizeRideQuoteStops(stops),
    vehicle_type: String(vehicle_type || '').trim().toLowerCase(),
  };
}

export function normalizeRideQuoteStops(stops = []) {
  if (!Array.isArray(stops)) return [];
  return stops
    .map((stop, index) => ({
      sequence: Number(stop?.sequence ?? index + 1),
      address: String(stop?.address || stop?.stop_address || stop?.location || '').trim().toLowerCase(),
    }))
    .filter((stop) => stop.address)
    .sort((a, b) => a.sequence - b.sequence)
    .slice(0, 5);
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2
    + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Straight-line pickup → dropoff distance for trip history (country-agnostic). */
export function routeDistanceKmFromCoords(pickupLat, pickupLng, dropLat, dropLng) {
  const vals = [pickupLat, pickupLng, dropLat, dropLng].map(Number);
  if (!vals.every(Number.isFinite)) return null;
  return haversineKm(vals[0], vals[1], vals[2], vals[3]);
}

export function routeDistanceKmFromRideRequest(rideRequest) {
  if (!rideRequest) return null;
  return routeDistanceKmFromCoords(
    rideRequest.pickup_lat,
    rideRequest.pickup_long,
    rideRequest.drop_lat,
    rideRequest.drop_long,
  );
}

/** Pickup → dropoff trip distance: Google route km when available, else Haversine. */
export async function resolveTripDistanceKm(rideRequest) {
  if (!rideRequest) return null;
  const metrics = await resolveRouteMetrics({
    pickup: rideRequest.pickup_address,
    dropoff: rideRequest.drop_address,
    pickup_lat: rideRequest.pickup_lat,
    pickup_long: rideRequest.pickup_long,
    drop_lat: rideRequest.drop_lat,
    drop_long: rideRequest.drop_long,
  });
  if (metrics?.dist_km > 0) {
    return parseFloat(metrics.dist_km.toFixed(2));
  }
  const straight = routeDistanceKmFromRideRequest(rideRequest);
  return straight != null && straight > 0 ? parseFloat(straight.toFixed(2)) : null;
}

/** Strug rideshare recommended-price formula (per requirements doc). */
export const FARE_RATES = {
  economy: { base: 2.50, per_km: 0.85, per_min: 0.18, booking_fee: 1.75 },
  comfort: { base: 3.50, per_km: 1.10, per_min: 0.22, booking_fee: 2.25 },
  premium: { base: 6.00, per_km: 1.80, per_min: 0.35, booking_fee: 3.50 },
  suv: { base: 4.50, per_km: 1.40, per_min: 0.28, booking_fee: 2.75 },
  xl: { base: 5.50, per_km: 1.60, per_min: 0.32, booking_fee: 3.00 },
  accessible: { base: 2.75, per_km: 0.90, per_min: 0.20, booking_fee: 1.75 },
};

export const RIDE_VEHICLE_TYPE_NAMES = Object.keys(FARE_RATES);
export const SERVICE_FEE_RATE = 0.05;

function parseLatLngPair(value) {
  if (value == null || value === '') return null;
  const parts = String(value).split(',').map((s) => Number(s.trim()));
  if (parts.length !== 2 || !parts.every(Number.isFinite)) return null;
  return { lat: parts[0], lng: parts[1] };
}

function haversineMetrics(lat1, lng1, lat2, lng2) {
  const dist_km = haversineKm(lat1, lng1, lat2, lng2);
  const duration_min = (dist_km / 30) * 60;
  return { dist_km, duration_min, source: 'haversine' };
}

/**
 * Resolve trip distance/duration: Distance Matrix (route) → geocode + haversine fallback.
 * Never returns zero distance when addresses/coords are valid.
 */
export async function resolveRouteMetrics({
  pickup,
  dropoff,
  pickup_lat,
  pickup_long,
  drop_lat,
  drop_long,
}) {
  const pickupStr = pickup?.trim?.() || null;
  const dropoffStr = dropoff?.trim?.() || null;

  if (pickupStr && dropoffStr) {
    const matrix = await getDistanceMatrix(pickupStr, dropoffStr);
    const meters = matrix?.distance?.value;
    const seconds = matrix?.duration?.value;
    if (meters > 0 && seconds > 0) {
      return {
        dist_km: meters / 1000,
        duration_min: seconds / 60,
        source: 'distance_matrix',
      };
    }
  }

  let pLat = pickup_lat != null ? Number(pickup_lat) : null;
  let pLng = pickup_long != null ? Number(pickup_long) : null;
  let dLat = drop_lat != null ? Number(drop_lat) : null;
  let dLng = drop_long != null ? Number(drop_long) : null;

  if ((pLat == null || pLng == null) && pickupStr) {
    const parsed = parseLatLngPair(pickupStr);
    if (parsed) {
      pLat = parsed.lat;
      pLng = parsed.lng;
    } else {
      const geo = await geocodeAddress(pickupStr);
      if (geo) {
        pLat = geo.lat;
        pLng = geo.lng;
      }
    }
  }

  if ((dLat == null || dLng == null) && dropoffStr) {
    const parsed = parseLatLngPair(dropoffStr);
    if (parsed) {
      dLat = parsed.lat;
      dLng = parsed.lng;
    } else {
      const geo = await geocodeAddress(dropoffStr);
      if (geo) {
        dLat = geo.lat;
        dLng = geo.lng;
      }
    }
  }

  if ([pLat, pLng, dLat, dLng].every((n) => Number.isFinite(n))) {
    return haversineMetrics(pLat, pLng, dLat, dLng);
  }

  return null;
}

export async function resolveMultiStopRouteMetrics({
  pickup,
  dropoff,
  pickup_lat,
  pickup_long,
  drop_lat,
  drop_long,
  stops = [],
}) {
  const normalizedStops = Array.isArray(stops)
    ? stops
      .map((stop, index) => ({
        sequence: Number(stop?.sequence ?? index + 1),
        address: String(stop?.address || stop?.stop_address || stop?.location || '').trim(),
        lat: stop?.lat ?? stop?.latitude ?? null,
        lng: stop?.lng ?? stop?.long ?? stop?.longitude ?? null,
      }))
      .filter((stop) => stop.address)
      .sort((a, b) => a.sequence - b.sequence)
      .slice(0, 5)
    : [];

  if (!normalizedStops.length) {
    return resolveRouteMetrics({ pickup, dropoff, pickup_lat, pickup_long, drop_lat, drop_long });
  }

  const legs = [];
  let cursor = { address: pickup, lat: pickup_lat, lng: pickup_long };
  for (const stop of normalizedStops) {
    legs.push({
      pickup: cursor.address,
      dropoff: stop.address,
      pickup_lat: cursor.lat,
      pickup_long: cursor.lng,
      drop_lat: stop.lat,
      drop_long: stop.lng,
    });
    cursor = { address: stop.address, lat: stop.lat, lng: stop.lng };
  }
  legs.push({
    pickup: cursor.address,
    dropoff,
    pickup_lat: cursor.lat,
    pickup_long: cursor.lng,
    drop_lat,
    drop_long,
  });

  let distKm = 0;
  let durationMin = 0;
  const sources = new Set();
  for (const leg of legs) {
    const metrics = await resolveRouteMetrics(leg);
    if (!metrics || metrics.dist_km <= 0) return null;
    distKm += metrics.dist_km;
    durationMin += metrics.duration_min;
    sources.add(metrics.source);
  }
  return {
    dist_km: distKm,
    duration_min: durationMin,
    source: sources.size === 1 ? [...sources][0] : 'multi_leg',
    leg_count: legs.length,
  };
}

export function getFareRates(vehicleTypeName) {
  const key = String(vehicleTypeName || 'economy').toLowerCase();
  return FARE_RATES[key] ?? FARE_RATES.economy;
}

/** Trip fare before service fee: base + per_km×dist + per_min×time + booking_fee */
export function calculateTripFare(vehicleTypeName, dist_km, duration_min) {
  const rates = getFareRates(vehicleTypeName);
  const trip_fare = rates.base
    + rates.per_km * dist_km
    + rates.per_min * duration_min
    + rates.booking_fee;
  return parseFloat(trip_fare.toFixed(2));
}

export function calculateRecommendedFareBreakdown(vehicleTypeName, dist_km, duration_min) {
  const trip_fare = calculateTripFare(vehicleTypeName, dist_km, duration_min);
  const service_fee = parseFloat((trip_fare * SERVICE_FEE_RATE).toFixed(2));
  const total = parseFloat((trip_fare + service_fee).toFixed(2));
  return {
    vehicle_type: String(vehicleTypeName || 'economy').toLowerCase(),
    dist_km: parseFloat(Number(dist_km).toFixed(2)),
    duration_min: Math.round(Number(duration_min)),
    trip_fare,
    base_fare: trip_fare,
    service_fee,
    total,
  };
}

export async function resolveVehicleTypeName(prismaClient, { vehicle_type, requested_type_id }) {
  if (vehicle_type) return String(vehicle_type).toLowerCase();
  if (requested_type_id) {
    const vt = await prismaClient.vehicle_types.findUnique({
      where: { vehicle_type_id: Number(requested_type_id) },
      select: { name: true },
    });
    if (vt?.name) return vt.name.toLowerCase();
  }
  return 'economy';
}

/**
 * Single source of truth for recommended-mode charge (estimate = create = confirm).
 */
export async function computeRecommendedFareForRide(prismaClient, params) {
  const {
    pickup_address,
    drop_address,
    pickup_lat,
    pickup_long,
    drop_lat,
    drop_long,
    stops = [],
    vehicle_type,
    requested_type_id,
    offered_fare,
  } = params;

  if (offered_fare != null && offered_fare !== '') {
    return Number(offered_fare);
  }

  const metrics = await resolveMultiStopRouteMetrics({
    pickup: pickup_address,
    dropoff: drop_address,
    pickup_lat,
    pickup_long,
    drop_lat,
    drop_long,
    stops,
  });
  if (!metrics || metrics.dist_km <= 0) return null;

  const vehicleTypeName = await resolveVehicleTypeName(prismaClient, {
    vehicle_type,
    requested_type_id,
  });
  const breakdown = calculateRecommendedFareBreakdown(
    vehicleTypeName,
    metrics.dist_km,
    metrics.duration_min,
  );
  return breakdown.total;
}

export async function buildFareEstimateResponse(prismaClient, {
  pickup,
  dropoff,
  vehicle_type,
  stops = [],
}) {
  const metrics = await resolveMultiStopRouteMetrics({ pickup, dropoff: dropoff, stops });
  if (!metrics || metrics.dist_km <= 0) {
    return {
      ok: false,
      status: 422,
      message: 'Could not calculate route. Provide valid addresses or coordinates.',
    };
  }

  const vehicleTypeName = vehicle_type
    ? String(vehicle_type).toLowerCase()
    : 'economy';
  if (!FARE_RATES[vehicleTypeName]) {
    return {
      ok: false,
      status: 400,
      message: `Unknown vehicle_type "${vehicle_type}".`,
    };
  }

  const breakdown = calculateRecommendedFareBreakdown(
    vehicleTypeName,
    metrics.dist_km,
    metrics.duration_min,
  );
  const quote = signQuote(breakdown.total, rideQuoteInputs({
    pickup_address: pickup, drop_address: dropoff, vehicle_type: vehicleTypeName, stops,
  }));
  return {
    ok: true,
    data: {
      successful: true,
      ...breakdown,
      route_source: metrics.source,
      quote_id: quote.quote_id,
      quote_expires_at: quote.expires_at,
    },
  };
}

export async function buildAllFareEstimatesResponse({ pickup, dropoff, pickup_lat, pickup_long, drop_lat, drop_long, stops = [] }) {
  const metrics = await resolveMultiStopRouteMetrics({
    pickup, dropoff, pickup_lat, pickup_long, drop_lat, drop_long, stops,
  });
  if (!metrics || metrics.dist_km <= 0) {
    return {
      ok: false,
      status: 422,
      message: 'Could not calculate route. Provide valid addresses or coordinates.',
    };
  }

  const estimates = {};
  for (const type of RIDE_VEHICLE_TYPE_NAMES) {
    const breakdown = calculateRecommendedFareBreakdown(
      type,
      metrics.dist_km,
      metrics.duration_min,
    );
    const quote = signQuote(breakdown.total, rideQuoteInputs({
      pickup_address: pickup, drop_address: dropoff, vehicle_type: type, stops,
    }));
    estimates[type] = { ...breakdown, quote_id: quote.quote_id, quote_expires_at: quote.expires_at };
  }

  return {
    ok: true,
    data: {
      successful: true,
      dist_km: parseFloat(metrics.dist_km.toFixed(2)),
      duration_min: Math.round(metrics.duration_min),
      route_source: metrics.source,
      estimates,
    },
  };
}
