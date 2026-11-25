import { normalizeRideStatus, RIDE_STATUS } from './ride-state-machine.js';

/** Pick the trip row used for passenger receipt / history (prefer completed). */
export function resolvePrimaryTrip(ride) {
  const trips = Array.isArray(ride?.active_trip) ? ride.active_trip : [];
  if (!trips.length) return null;
  const completed = trips.find((t) => t?.ended_at);
  return completed ?? trips[0];
}

export function formatRidePaymentMethodLabel(method) {
  const m = String(method || '').toLowerCase();
  if (m === 'card') return 'Credit / Debit Card';
  if (m === 'wallet') return 'Strug Wallet';
  if (m === 'cash') return 'Cash';
  if (m === 'paypal') return 'PayPal';
  return method || null;
}

function driverDisplayName(trip) {
  const user = trip?.driver_profile?.user;
  return user?.name ?? user?.display_name ?? null;
}

function vehicleTypeLabel(ride, trip) {
  const tripVehicle = trip?.vehicle;
  return (
    ride?.vehicle_types?.name
    ?? tripVehicle?.vehicle_types?.name
    ?? trip?.driver_profile?.vehicle?.vehicle_types?.name
    ?? trip?.driver_profile?.vehicle?.model
    ?? tripVehicle?.model
    ?? null
  );
}

function parseMoneyAmount(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (Number.isNaN(n)) return null;
  return parseFloat(n.toFixed(2));
}

function parseDistanceKm(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (Number.isNaN(n)) return null;
  return parseFloat(n.toFixed(2));
}

export function formatReceiptDateTime(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' });
}

/** True when a finalized passenger receipt can be built (trip completed). */
export function isRideReceiptAvailable(ride, trip = null) {
  const primaryTrip = trip ?? resolvePrimaryTrip(ride);
  if (!ride || !primaryTrip?.ended_at) return false;
  const rideStatus = normalizeRideStatus(ride.status);
  return rideStatus === RIDE_STATUS.COMPLETED && primaryTrip.ended_at != null;
}

/**
 * Canonical passenger receipt — single source for in-app, email, and order history.
 * Returns null until the trip is completed (ended_at set).
 */
export function buildRideReceiptPayload(ride, trip = null, options = {}) {
  if (!ride) return null;
  const primaryTrip = trip ?? resolvePrimaryTrip(ride);
  if (!isRideReceiptAvailable(ride, primaryTrip)) return null;

  const currency = options.currency ?? ride?.user?.currency ?? 'CAD';
  const total_fare = parseMoneyAmount(
    primaryTrip.total_fare ?? ride.offered_fare ?? ride.estimated_fare,
  );
  const distance_km = parseDistanceKm(primaryTrip.actual_distance_km);
  const payment_method = primaryTrip.payment_method ?? null;
  const completed_at = primaryTrip.ended_at?.toISOString?.()
    ?? (primaryTrip.ended_at ? new Date(primaryTrip.ended_at).toISOString() : null);
  const booked_at = ride.created_at?.toISOString?.()
    ?? (ride.created_at ? new Date(ride.created_at).toISOString() : null);

  return {
    ride_request_id: ride.ride_request_id,
    trip_id: primaryTrip.trip_id ?? null,
    pickup_address: ride.pickup_address ?? null,
    drop_address: ride.drop_address ?? null,
    driver_name: driverDisplayName(primaryTrip),
    vehicle_type: vehicleTypeLabel(ride, primaryTrip),
    payment_method,
    payment_method_label: formatRidePaymentMethodLabel(payment_method),
    total_fare,
    currency,
    distance_km,
    completed_at,
    completed_at_label: formatReceiptDateTime(primaryTrip.ended_at ?? completed_at),
    booked_at,
    ride_id_label: ride.ride_request_id != null ? `#${ride.ride_request_id}` : null,
    trip_id_label: primaryTrip.trip_id != null ? `#${primaryTrip.trip_id}` : null,
  };
}

/** Handlebars / sendEmail context for ride-receipt.hbs */
export function buildRideReceiptEmailVars(receipt) {
  if (!receipt) return {};
  return {
    total_fare: receipt.total_fare != null ? receipt.total_fare.toFixed(2) : '—',
    currency: receipt.currency ?? 'CAD',
    distance: receipt.distance_km != null ? receipt.distance_km.toFixed(2) : '—',
    driver_name: receipt.driver_name ?? 'Driver',
    pickup_address: receipt.pickup_address ?? '—',
    drop_address: receipt.drop_address ?? '—',
    ride_id: receipt.ride_id_label ?? '—',
    trip_id: receipt.trip_id_label ?? '—',
    completed_at: receipt.completed_at_label ?? '—',
    vehicle_type: receipt.vehicle_type ?? '—',
    payment_method: receipt.payment_method_label ?? '—',
  };
}
