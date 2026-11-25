import { describe, it, expect } from 'vitest';
import {
  SHOP_API_GEO_RADIUS_KM,
  SHOP_MAX_BROWSE_DISTANCE_KM,
  SHOP_LISTINGS_PUBLIC_CAP,
} from '../../utils/shop-constants.js';

describe('shop-constants', () => {
  it('exports geo radius aligned with frontend shopMappers', () => {
    expect(SHOP_API_GEO_RADIUS_KM).toBe(20);
    expect(SHOP_MAX_BROWSE_DISTANCE_KM).toBe(50);
  });

  it('exports a sensible public listing cap', () => {
    expect(SHOP_LISTINGS_PUBLIC_CAP).toBeGreaterThan(0);
    expect(SHOP_LISTINGS_PUBLIC_CAP).toBe(500);
  });
});
