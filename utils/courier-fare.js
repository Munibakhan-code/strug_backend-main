// utils/courier-fare.js
//
// Board #460: "Current UX issue shows pricing before selecting anything or putting a location plus
// distance."
//
// Courier had NO fare engine at all. The frontend added up two hardcoded numbers — a per-vehicle
// price (bike $6 / car $12 / van $22) and a per-package price — so it quoted a confident total
// before the user had entered a pickup, a drop-off, or anything else. The distance was never part
// of it, which means the quote was not just premature, it was wrong.
//
// Rideshare already has a proper route engine (resolveRouteMetrics -> dist_km + duration_min).
// Reuse it, and price courier the same way rideshare does: a per-vehicle base + distance + time,
// plus a package surcharge for what's actually being carried.
import { resolveRouteMetrics, SERVICE_FEE_RATE } from './ride-fare.js';
import { signQuote } from './price-quote.js';

/** Inputs a courier quote is locked against — same shape at quote time and at booking time. */
export function courierQuoteInputs({ pickup, dropoff, vehicle, packageType, urgent }) {
  return {
    v: 'courier',
    pickup: String(pickup || '').trim().toLowerCase(),
    dropoff: String(dropoff || '').trim().toLowerCase(),
    vehicle: String(vehicle || '').trim().toLowerCase(),
    packageType: String(packageType || '').trim().toLowerCase(),
    urgent: !!urgent,
  };
}

// Bike is cheapest and slowest per km; a van costs more to run. Mirrors the shape of FARE_RATES.
export const COURIER_VEHICLE_RATES = {
  bike: { base: 3.00, per_km: 0.80, per_min: 0.12, booking_fee: 1.25 },
  car:  { base: 5.00, per_km: 1.15, per_min: 0.18, booking_fee: 1.75 },
  van:  { base: 9.00, per_km: 1.75, per_min: 0.28, booking_fee: 2.50 },
};

// What is being carried, not how far — so this stays a flat surcharge on top of the route price.
export const COURIER_PACKAGE_SURCHARGE = {
  envelope: 0.00,
  small:    2.00,
  large:    6.00,
  fragile:  9.00,
};

export const COURIER_VEHICLE_NAMES = Object.keys(COURIER_VEHICLE_RATES);

// A rush job pays the courier to drop everything else.
export const COURIER_URGENT_SURCHARGE = 8.00;

const round2 = (n) => Math.round(n * 100) / 100;

export function calculateCourierFare(vehicle, dist_km, duration_min, { packageType, urgent } = {}) {
  const rate = COURIER_VEHICLE_RATES[vehicle];
  if (!rate) return null;

  const distance_fare = rate.per_km * dist_km;
  const time_fare = rate.per_min * duration_min;
  const pkg = COURIER_PACKAGE_SURCHARGE[packageType] ?? 0;
  const urgent_fee = urgent ? COURIER_URGENT_SURCHARGE : 0;

  const subtotal = rate.base + distance_fare + time_fare + rate.booking_fee + pkg + urgent_fee;
  const service_fee = subtotal * SERVICE_FEE_RATE;

  return {
    base_fare: round2(rate.base),
    distance_fare: round2(distance_fare),
    time_fare: round2(time_fare),
    booking_fee: round2(rate.booking_fee),
    package_surcharge: round2(pkg),
    urgent_fee: round2(urgent_fee),
    service_fee: round2(service_fee),
    total: round2(subtotal + service_fee),
  };
}

/**
 * Price every courier vehicle for one route, in a single route resolve.
 * Mirrors buildAllFareEstimatesResponse() in ride-fare.js.
 */
export async function buildCourierFareEstimates({ pickup, dropoff, packageType, urgent }) {
  const metrics = await resolveRouteMetrics({ pickup, dropoff });
  if (!metrics || metrics.dist_km <= 0) {
    return {
      ok: false,
      status: 422,
      message: 'Could not calculate route. Provide valid addresses or coordinates.',
    };
  }

  const estimates = {};
  for (const vehicle of COURIER_VEHICLE_NAMES) {
    const breakdown = calculateCourierFare(vehicle, metrics.dist_km, metrics.duration_min, {
      packageType,
      urgent,
    });
    const quote = signQuote(breakdown.total, courierQuoteInputs({ pickup, dropoff, vehicle, packageType, urgent }));
    estimates[vehicle] = { ...breakdown, quote_id: quote.quote_id, quote_expires_at: quote.expires_at };
  }

  return {
    ok: true,
    data: {
      dist_km: round2(metrics.dist_km),
      duration_min: Math.round(metrics.duration_min),
      route_source: metrics.source,
      estimates,
    },
  };
}
