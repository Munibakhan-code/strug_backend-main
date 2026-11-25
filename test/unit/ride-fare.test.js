import { describe, it, expect } from 'vitest';
import {
  haversineKm,
  routeDistanceKmFromCoords,
  routeDistanceKmFromRideRequest,
  getFareRates,
  calculateTripFare,
  calculateRecommendedFareBreakdown,
  FARE_RATES,
  RIDE_VEHICLE_TYPE_NAMES,
  SERVICE_FEE_RATE,
} from '../../utils/ride-fare.js';

describe('FARE_RATES / constants', () => {
  it('exposes the six vehicle types and a 5% service fee', () => {
    expect(RIDE_VEHICLE_TYPE_NAMES).toEqual([
      'economy', 'comfort', 'premium', 'suv', 'xl', 'accessible',
    ]);
    expect(SERVICE_FEE_RATE).toBe(0.05);
  });
});

describe('getFareRates', () => {
  it('is case-insensitive', () => {
    expect(getFareRates('ECONOMY')).toEqual(FARE_RATES.economy);
    expect(getFareRates('Comfort')).toEqual(FARE_RATES.comfort);
  });
  it('falls back to economy on unknown / empty / nullish type', () => {
    expect(getFareRates('does-not-exist')).toEqual(FARE_RATES.economy);
    expect(getFareRates('')).toEqual(FARE_RATES.economy);
    expect(getFareRates(undefined)).toEqual(FARE_RATES.economy);
    expect(getFareRates(null)).toEqual(FARE_RATES.economy);
  });
});

describe('calculateTripFare', () => {
  it('economy 10km/20min = 16.35 (2.50 + 0.85*10 + 0.18*20 + 1.75)', () => {
    expect(calculateTripFare('economy', 10, 20)).toBe(16.35);
  });
  it('comfort 10km/20min = 21.15 (3.50 + 1.10*10 + 0.22*20 + 2.25)', () => {
    expect(calculateTripFare('comfort', 10, 20)).toBe(21.15);
  });
  it('rounds to 2 decimals', () => {
    // premium: 6.00 + 1.80*3.3 + 0.35*7 + 3.50 = 6 + 5.94 + 2.45 + 3.5 = 17.89
    expect(calculateTripFare('premium', 3.3, 7)).toBe(17.89);
  });
  it('unknown type is priced as economy', () => {
    expect(calculateTripFare('nope', 10, 20)).toBe(calculateTripFare('economy', 10, 20));
  });
});

describe('calculateRecommendedFareBreakdown', () => {
  it('economy 10km/20min → trip 16.35, fee 0.82, total 17.17', () => {
    const b = calculateRecommendedFareBreakdown('economy', 10, 20);
    expect(b).toMatchObject({
      vehicle_type: 'economy',
      dist_km: 10,
      duration_min: 20,
      trip_fare: 16.35,
      base_fare: 16.35,
      service_fee: 0.82, // round(16.35 * 0.05) = round(0.8175) = 0.82
      total: 17.17,
    });
  });

  it('lowercases the vehicle type and rounds dist/duration', () => {
    const b = calculateRecommendedFareBreakdown('PREMIUM', 3.333, 7.6);
    expect(b.vehicle_type).toBe('premium');
    expect(b.dist_km).toBe(3.33);     // toFixed(2)
    expect(b.duration_min).toBe(8);   // Math.round(7.6)
  });

  it('for every vehicle type, total === trip_fare + service_fee', () => {
    for (const type of RIDE_VEHICLE_TYPE_NAMES) {
      const b = calculateRecommendedFareBreakdown(type, 12.5, 25);
      expect(b.service_fee).toBe(Number((b.trip_fare * SERVICE_FEE_RATE).toFixed(2)));
      expect(b.total).toBe(Number((b.trip_fare + b.service_fee).toFixed(2)));
    }
  });
});

describe('haversineKm', () => {
  it('same point ≈ 0', () => {
    expect(haversineKm(6.9, 79.86, 6.9, 79.86)).toBeCloseTo(0, 5);
  });
  it('Colombo → Kandy is roughly 90+ km', () => {
    const d = haversineKm(6.9271, 79.8612, 7.2906, 80.6337);
    expect(d).toBeGreaterThan(89);
    expect(d).toBeLessThan(100);
  });
  it('is symmetric', () => {
    const ab = haversineKm(6.9271, 79.8612, 7.2906, 80.6337);
    const ba = haversineKm(7.2906, 80.6337, 6.9271, 79.8612);
    expect(ab).toBeCloseTo(ba, 9);
  });
});

describe('routeDistanceKmFromCoords', () => {
  it('returns a positive distance for valid coords', () => {
    const d = routeDistanceKmFromCoords(6.9271, 79.8612, 7.2906, 80.6337);
    expect(d).toBeGreaterThan(89);
  });
  it('returns null when any coord is non-finite (undefined / NaN / non-numeric)', () => {
    expect(routeDistanceKmFromCoords('x', 1, 2, 3)).toBeNull();
    expect(routeDistanceKmFromCoords(6.9, 79.8, undefined, 80)).toBeNull();
    expect(routeDistanceKmFromCoords(6.9, 79.8, NaN, 80)).toBeNull();
  });
  it('accepts numeric strings (coerced via Number)', () => {
    const d = routeDistanceKmFromCoords('6.9271', '79.8612', '7.2906', '80.6337');
    expect(d).toBeGreaterThan(89);
  });
});

describe('routeDistanceKmFromRideRequest', () => {
  it('returns null for a nullish request', () => {
    expect(routeDistanceKmFromRideRequest(null)).toBeNull();
    expect(routeDistanceKmFromRideRequest(undefined)).toBeNull();
  });
  it('maps the ride_request fields to coords', () => {
    const d = routeDistanceKmFromRideRequest({
      pickup_lat: 6.9271, pickup_long: 79.8612, drop_lat: 7.2906, drop_long: 80.6337,
    });
    expect(d).toBeGreaterThan(89);
  });
  it('returns null when a coordinate field is absent', () => {
    expect(routeDistanceKmFromRideRequest({
      pickup_lat: 6.9271, pickup_long: 79.8612, drop_lat: 7.2906, // drop_long missing
    })).toBeNull();
  });
});
