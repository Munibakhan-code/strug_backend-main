import { describe, it, expect } from 'vitest';
import { filterListingsByRadius, parseListingGeoQuery } from '../../utils/booking-listing-geo.js';

describe('booking-listing-geo (Medical Phase 2)', () => {
  it('parseListingGeoQuery validates lat/lng/radius_km', () => {
    expect(parseListingGeoQuery({ lat: '43.65', lng: '-79.38', radius_km: '25' })).toEqual({
      lat: 43.65,
      lng: -79.38,
      radiusKm: 25,
    });
    expect(parseListingGeoQuery({})).toBeNull();
    expect(parseListingGeoQuery({ lat: 'x', lng: '-79', radius_km: '10' })).toBeNull();
    expect(parseListingGeoQuery({ lat: '43', lng: '-79', radius_km: '0' })).toBeNull();
  });

  it('filterListingsByRadius keeps listings within radius and drops missing coords', () => {
    const rows = [
      { booking_listing_id: 1, latitude: 43.65, longitude: -79.38 },
      { booking_listing_id: 2, latitude: 45.42, longitude: -75.69 },
      { booking_listing_id: 3, latitude: null, longitude: null },
    ];
    const filtered = filterListingsByRadius(rows, { lat: 43.65, lng: -79.38, radiusKm: 30 });
    expect(filtered.map((r) => r.booking_listing_id)).toEqual([1]);
    expect(filtered[0].distance_km).toBeLessThan(1);
  });
});
