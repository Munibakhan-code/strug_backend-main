import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/google-maps.js', () => ({
  getDistanceMatrix: vi.fn(),
  geocodeAddress: vi.fn(),
}));

const { getDistanceMatrix, geocodeAddress } = await import('../../utils/google-maps.js');
const {
  parseFiniteCoord,
  isUsableLatLng,
  assertFoodDeliveryInRange,
} = await import('../../utils/food-delivery-pricing.js');

describe('parseFiniteCoord / isUsableLatLng', () => {
  it('does not coerce null or undefined to 0', () => {
    expect(parseFiniteCoord(null)).toBeNull();
    expect(parseFiniteCoord(undefined)).toBeNull();
    expect(parseFiniteCoord('')).toBeNull();
    expect(parseFiniteCoord(29.7)).toBe(29.7);
    expect(parseFiniteCoord('72.5')).toBe(72.5);
  });

  it('rejects Null Island (0,0) as unusable', () => {
    expect(isUsableLatLng(0, 0)).toBe(false);
    expect(isUsableLatLng(null, null)).toBe(false);
    expect(isUsableLatLng(29.7, 72.5)).toBe(true);
  });
});

describe('assertFoodDeliveryInRange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDistanceMatrix.mockResolvedValue(null);
    geocodeAddress.mockResolvedValue(null);
  });

  it('does not reject when delivery_lat/lng are null (former Number(null)=0 bug)', async () => {
    // Restaurant in Hasilpur; missing delivery coords must NOT become (0,0) → ~8328 km.
    const result = await assertFoodDeliveryInRange({
      vendorLocation: 'Hasilpur, Punjab, Pakistan',
      deliverLocation: 'Hasilpur-Chistian Road, Muhammad Pannah Mor, Punjab, Pakistan',
      vendorLat: 29.6969,
      vendorLong: 72.5454,
      deliverLat: null,
      deliverLng: null,
    });
    expect(result.ok).toBe(true);
    expect(result.distanceKm).toBeNull();
  });

  it('does not treat explicit 0,0 delivery coords as a real destination', async () => {
    const result = await assertFoodDeliveryInRange({
      vendorLocation: 'Hasilpur, Punjab, Pakistan',
      deliverLocation: 'Hasilpur, Punjab, Pakistan',
      vendorLat: 29.6969,
      vendorLong: 72.5454,
      deliverLat: 0,
      deliverLng: 0,
    });
    // 0,0 is rejected; without geocode result we allow rather than invent distance.
    expect(result.ok).toBe(true);
  });

  it('rejects real far-apart coordinates via Haversine', async () => {
    const result = await assertFoodDeliveryInRange({
      vendorLocation: 'Hasilpur, Punjab, Pakistan',
      deliverLocation: 'Toronto, ON',
      vendorLat: 29.6969,
      vendorLong: 72.5454,
      deliverLat: 43.6532,
      deliverLng: -79.3832,
    });
    expect(result.ok).toBe(false);
    expect(result.distanceKm).toBeGreaterThan(25);
  });

  it('accepts nearby coordinates', async () => {
    const result = await assertFoodDeliveryInRange({
      vendorLocation: 'Hasilpur, Punjab, Pakistan',
      deliverLocation: 'Hasilpur-Chistian Road, Punjab, Pakistan',
      vendorLat: 29.6969,
      vendorLong: 72.5454,
      deliverLat: 29.70,
      deliverLng: 72.55,
    });
    expect(result.ok).toBe(true);
    expect(result.distanceKm).toBeLessThan(25);
  });

  it('geocodes missing delivery coords when address text is present', async () => {
    geocodeAddress.mockResolvedValue({ lat: 29.70, lng: 72.55 });
    const result = await assertFoodDeliveryInRange({
      vendorLocation: 'Hasilpur, Punjab, Pakistan',
      deliverLocation: 'Hasilpur-Chistian Road, Punjab, Pakistan',
      vendorLat: 29.6969,
      vendorLong: 72.5454,
      deliverLat: null,
      deliverLng: null,
    });
    expect(geocodeAddress).toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.distanceKm).toBeLessThan(25);
  });

  it('uses Distance Matrix when available', async () => {
    getDistanceMatrix.mockResolvedValue({ distance: { value: 3200 } });
    const result = await assertFoodDeliveryInRange({
      vendorLocation: 'A',
      deliverLocation: 'B',
      vendorLat: null,
      vendorLong: null,
      deliverLat: null,
      deliverLng: null,
    });
    expect(result.ok).toBe(true);
    expect(result.distanceKm).toBeCloseTo(3.2);
  });
});
