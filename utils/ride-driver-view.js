/** Driver-facing API shapes — earnings only, no rider total / platform fee exposure. */

import { MIN_HISTORY_FOR_ACCEPTANCE_SCORING } from './ride-dispatch.js';

/**
 * Acceptance rate for driver-facing display — same threshold ride-dispatch's scoring uses,
 * so what a driver sees matches what actually affects the offers they get. Returns null
 * (not 0 or 100%) below the history threshold rather than implying a rate that isn't real yet.
 */
export function computeDriverAcceptanceRate(profile) {
  const accepted = profile?.accept_count || 0;
  const declined = profile?.decline_count || 0;
  const total = accepted + declined;
  if (total < MIN_HISTORY_FOR_ACCEPTANCE_SCORING) return null;
  return Math.round((accepted / total) * 1000) / 10; // one decimal place, as a percentage
}

/** Drop internal settlement audit fields before a payload leaves the server (e.g. broadcasts). */
export function stripInternalSettlementFields(trip) {
  if (!trip) return trip;
  const { driver_payout: _dp, platform_fee: _pf, ...rest } = trip;
  return rest;
}

/** Driver-facing trip row — earnings only (no rider total / platform fee). */
export function sanitizeActiveTripForDriver(trip) {
  if (!trip) return trip;
  let earnings = trip.driver_payout;
  if (earnings == null && trip.total_fare != null) {
    earnings = parseFloat((Number(trip.total_fare) * 0.79).toFixed(2));
  }
  const out = { ...trip, driver_payout: earnings, tip_amount: trip.tip_amount ?? 0 };
  delete out.total_fare;
  delete out.platform_fee;
  if (out.ride_request) {
    const rr = { ...out.ride_request };
    delete rr.offered_fare;
    delete rr.estimated_fare;
    out.ride_request = rr;
  }
  return out;
}

export function sanitizeDriverTripHistoryRow(trip) {
  if (!trip) return trip;
  let earnings = trip.driver_payout;
  if (earnings == null && trip.total_fare != null) {
    earnings = parseFloat((Number(trip.total_fare) * 0.79).toFixed(2));
  }
  return {
    trip_id: trip.trip_id,
    request_id: trip.request_id,
    driver_id: trip.driver_id,
    started_at: trip.started_at,
    ended_at: trip.ended_at,
    actual_distance_km: trip.actual_distance_km,
    driver_payout: earnings,
    tip_amount: trip.tip_amount ?? 0,
    payment_method: trip.payment_method,
    ride_request: trip.ride_request
      ? {
          pickup_address: trip.ride_request.pickup_address,
          drop_address: trip.ride_request.drop_address,
          user: trip.ride_request.user
            ? { name: trip.ride_request.user.name }
            : null,
        }
      : null,
  };
}

export function sanitizeDriverEarningsStats(stats) {
  if (!stats) return stats;
  const {
    gross_earnings: _g,
    total_earnings: _t,
    platform_fees: _p,
    ...rest
  } = stats;
  return rest;
}
