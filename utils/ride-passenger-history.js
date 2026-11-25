import { normalizeRideStatus, RIDE_STATUS } from './ride-state-machine.js';
import {
  buildRideReceiptPayload,
  formatRidePaymentMethodLabel,
  resolvePrimaryTrip,
} from './ride-receipt.js';

/** Map ride + trip state to order-history friendly status. */
export function mapPassengerHistoryStatus(ride, trip) {
  const rideStatus = normalizeRideStatus(ride?.status);
  if (rideStatus === RIDE_STATUS.CANCELLED) return 'cancelled';
  if (rideStatus === RIDE_STATUS.COMPLETED || trip?.ended_at) return 'completed';
  if (rideStatus === RIDE_STATUS.ONGOING) return 'in-progress';
  if (rideStatus === RIDE_STATUS.ACCEPTED && trip && !trip.ended_at) return 'in-progress';
  if (rideStatus === 'pending_payment') return 'pending';
  if (rideStatus === RIDE_STATUS.PENDING) return 'pending';
  return rideStatus || 'pending';
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

function parseTotalFare(ride, trip) {
  const totalRaw = trip?.total_fare ?? ride?.offered_fare ?? ride?.estimated_fare;
  return totalRaw != null && !Number.isNaN(Number(totalRaw))
    ? parseFloat(Number(totalRaw).toFixed(2))
    : null;
}

/**
 * Shape one ride_request row for passenger trip history / order history UI.
 */
export function formatPassengerTripHistoryItem(ride) {
  const trip = resolvePrimaryTrip(ride);
  const status = mapPassengerHistoryStatus(ride, trip);
  const currency = ride?.user?.currency ?? 'CAD';
  const receipt = buildRideReceiptPayload(ride, trip, { currency });

  const bookedAt = ride?.created_at?.toISOString?.() ?? ride?.created_at ?? null;
  const completedAt = trip?.ended_at?.toISOString?.() ?? trip?.ended_at ?? null;

  return {
    ride_request_id: ride.ride_request_id,
    trip_id: trip?.trip_id ?? null,
    status,
    display_status: status.replace('-', ' '),
    pickup_address: ride.pickup_address ?? null,
    drop_address: ride.drop_address ?? null,
    vehicle_type: receipt?.vehicle_type ?? vehicleTypeLabel(ride, trip),
    driver_name: receipt?.driver_name ?? driverDisplayName(trip),
    total_fare: receipt?.total_fare ?? parseTotalFare(ride, trip),
    estimated_fare: ride.estimated_fare ?? null,
    offered_fare: ride.offered_fare ?? null,
    pricing_mode: ride.offered_fare != null ? 'set_price' : 'recommended',
    payment_method: receipt?.payment_method_label ?? formatRidePaymentMethodLabel(trip?.payment_method),
    distance_km: receipt?.distance_km ?? (
      trip?.actual_distance_km != null
        ? parseFloat(Number(trip.actual_distance_km).toFixed(2))
        : null
    ),
    currency: receipt?.currency ?? currency,
    rating: trip?.ride_rating?.rating ?? null,
    review: trip?.ride_rating?.review ?? null,
    booked_at: bookedAt,
    completed_at: completedAt,
    created_at: bookedAt,
    receipt,
  };
}
