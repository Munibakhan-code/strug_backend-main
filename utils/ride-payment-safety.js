/** Rideshare + shared payment amount guards (Phase 1). */

export const RIDE_MIN_CHARGE_AMOUNT = Number(process.env.RIDE_MIN_CHARGE_AMOUNT ?? 0.5);
export const RIDE_MAX_CHARGE_AMOUNT = Number(process.env.RIDE_MAX_CHARGE_AMOUNT ?? 500);

const AMOUNT_TOLERANCE = 0.02;

/**
 * @param {unknown} amount
 * @param {{ ride?: { offered_fare?: number|null, estimated_fare?: number|null } }} [opts]
 */
export function validateChargeAmount(amount, opts = {}) {
  const num = typeof amount === 'number' ? amount : parseFloat(amount);
  if (amount == null || amount === '' || Number.isNaN(num)) {
    return { ok: false, status: 400, error: 'Invalid amount' };
  }
  if (num < RIDE_MIN_CHARGE_AMOUNT) {
    return {
      ok: false,
      status: 400,
      error: `Invalid amount — minimum charge is $${RIDE_MIN_CHARGE_AMOUNT.toFixed(2)}`,
    };
  }
  if (num > RIDE_MAX_CHARGE_AMOUNT) {
    return {
      ok: false,
      status: 400,
      error: `Invalid amount — maximum charge is $${RIDE_MAX_CHARGE_AMOUNT.toFixed(2)}`,
    };
  }

  const { ride } = opts;
  if (ride) {
    const expected = ride.offered_fare ?? ride.estimated_fare;
    if (expected == null || Number.isNaN(Number(expected))) {
      return { ok: false, status: 400, error: 'Ride has no valid fare to charge' };
    }
    if (Math.abs(num - Number(expected)) > AMOUNT_TOLERANCE) {
      return { ok: false, status: 400, error: 'Amount does not match the fare for this ride' };
    }
  }

  return { ok: true, amount: parseFloat(num.toFixed(2)) };
}

export function getExpectedChargeForRide(ride) {
  if (!ride) return null;
  const total = ride.offered_fare ?? ride.estimated_fare;
  return total == null ? null : Number(total);
}

/**
 * Stripe idempotency key (max 255 chars).
 * @param {{ rideRequestId?: number|null, clientKey?: string|null }} params
 */
export function buildStripeIdempotencyKey({ rideRequestId, clientKey }) {
  if (rideRequestId != null && !Number.isNaN(Number(rideRequestId))) {
    return `rideshare-pi-${Number(rideRequestId)}`;
  }
  if (clientKey && typeof clientKey === 'string') {
    const safe = clientKey.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 200);
    if (safe.length >= 8) return `rideshare-pi-${safe}`;
  }
  return null;
}
