import { describe, it, expect } from 'vitest';
import {
  buildRideReceiptPayload,
  buildRideReceiptEmailVars,
  formatRidePaymentMethodLabel,
  isRideReceiptAvailable,
} from '../../utils/ride-receipt.js';

const completedRide = {
  ride_request_id: 96,
  status: 'completed',
  pickup_address: '55 York St, Toronto',
  drop_address: '2 Inwood Ave, East York',
  offered_fare: 24.76,
  estimated_fare: 22.0,
  created_at: new Date('2026-06-19T06:00:00Z'),
  vehicle_types: { name: 'Economy' },
  user: { currency: 'CAD' },
};

const completedTrip = {
  trip_id: 42,
  ended_at: new Date('2026-06-19T07:33:00Z'),
  total_fare: 24.76,
  actual_distance_km: 8.4,
  payment_method: 'wallet',
  driver_profile: {
    user: { name: 'Baqar driver' },
    vehicle: { model: 'Camry', vehicle_types: { name: 'Comfort' } },
  },
};

describe('buildRideReceiptPayload', () => {
  it('builds canonical payload from completed trip', () => {
    const receipt = buildRideReceiptPayload(completedRide, completedTrip);
    expect(receipt.ride_request_id).toBe(96);
    expect(receipt.trip_id).toBe(42);
    expect(receipt.total_fare).toBe(24.76);
    expect(receipt.payment_method_label).toBe('Strug Wallet');
    expect(receipt.distance_km).toBe(8.4);
    expect(receipt.driver_name).toBe('Baqar driver');
    expect(receipt.vehicle_type).toBe('Economy');
    expect(receipt.completed_at_label).toBeTruthy();
  });

  it('uses trip.total_fare over ride estimate', () => {
    const receipt = buildRideReceiptPayload(completedRide, completedTrip);
    expect(receipt.total_fare).toBe(24.76);
  });

  it('returns null before trip completes', () => {
    const openTrip = { ...completedTrip, ended_at: null };
    expect(isRideReceiptAvailable(completedRide, openTrip)).toBe(false);
    expect(buildRideReceiptPayload(completedRide, openTrip)).toBeNull();
  });
});

describe('formatRidePaymentMethodLabel', () => {
  it('formats known payment methods', () => {
    expect(formatRidePaymentMethodLabel('card')).toBe('Credit / Debit Card');
    expect(formatRidePaymentMethodLabel('wallet')).toBe('Strug Wallet');
  });
});

describe('buildRideReceiptEmailVars', () => {
  it('matches receipt totals for email template', () => {
    const receipt = buildRideReceiptPayload(completedRide, completedTrip);
    const email = buildRideReceiptEmailVars(receipt);
    expect(email.total_fare).toBe('24.76');
    expect(email.currency).toBe('CAD');
    expect(email.payment_method).toBe('Strug Wallet');
    expect(email.ride_id).toBe('#96');
    expect(email.trip_id).toBe('#42');
    expect(email.distance).toBe('8.40');
  });
});
