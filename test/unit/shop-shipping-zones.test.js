import { describe, it, expect } from 'vitest';
import {
  isBuyerLocalToStore,
  matchShippingZone,
  quoteShipping,
  sanitizeZoneInput,
  normalizePlaceKey,
} from '../../utils/shop-shipping-zones.js';

const store = { lat: 43.65, lng: -79.38 };

const zones = [
  {
    zone_id: 1,
    name: 'Canada',
    match_type: 'country',
    country: 'Canada',
    city: null,
    fee: 8.5,
    priority: 100,
    is_active: true,
  },
  {
    zone_id: 2,
    name: 'Toronto',
    match_type: 'city',
    country: 'Canada',
    city: 'Toronto',
    fee: 4,
    priority: 10,
    is_active: true,
  },
  {
    zone_id: 3,
    name: 'Pakistan',
    match_type: 'country',
    country: 'Pakistan',
    city: null,
    fee: 22,
    priority: 50,
    is_active: true,
  },
];

describe('normalizePlaceKey / isBuyerLocalToStore', () => {
  it('normalizes place strings', () => {
    expect(normalizePlaceKey('  Canada ')).toBe('canada');
  });

  it('detects local buyers inside radius', () => {
    expect(isBuyerLocalToStore(43.66, -79.39, store, 20)).toBe(true);
    expect(isBuyerLocalToStore(45.5, -73.6, store, 20)).toBe(false);
    expect(isBuyerLocalToStore(null, null, store, 20)).toBe(false);
  });
});

describe('matchShippingZone', () => {
  it('prefers city over country when city matches', () => {
    const hit = matchShippingZone(zones, { country: 'Canada', city: 'Toronto' });
    expect(hit.zone_id).toBe(2);
    expect(hit.fee).toBe(4);
  });

  it('falls back to country zone', () => {
    const hit = matchShippingZone(zones, { country: 'pakistan', city: 'Karachi' });
    expect(hit.zone_id).toBe(3);
    expect(hit.fee).toBe(22);
  });

  it('returns null when no country match', () => {
    expect(matchShippingZone(zones, { country: 'China' })).toBeNull();
  });
});

describe('quoteShipping', () => {
  it('uses delivery for local buyers', () => {
    const q = quoteShipping({
      store,
      zones,
      buyer: { lat: 43.66, lng: -79.39, country: 'Canada', city: 'Toronto' },
    });
    expect(q).toMatchObject({ ok: true, local: true, mode: 'delivery' });
    expect(q.fee).toBeGreaterThan(0);
  });

  it('quotes ship_by_seller zone fee for remote buyers', () => {
    const q = quoteShipping({
      store,
      zones,
      buyer: { lat: 31.52, lng: 74.35, country: 'Pakistan', city: 'Lahore' },
    });
    expect(q).toMatchObject({
      ok: true,
      local: false,
      mode: 'ship_by_seller',
      fee: 22,
      zone_id: 3,
    });
  });

  it('uses legacy ship fee when seller has no zones and buyer is remote', () => {
    const q = quoteShipping({
      store,
      zones: [],
      buyer: { lat: 31.52, lng: 74.35, country: 'Pakistan' },
    });
    expect(q).toMatchObject({
      ok: true,
      local: false,
      mode: 'ship_by_seller',
      fee: 4.99,
      zone_id: null,
    });
  });

  it('errors when remote and no matching zone', () => {
    const q = quoteShipping({
      store,
      zones,
      buyer: { lat: 39.9, lng: 116.4, country: 'China' },
    });
    expect(q.ok).toBe(false);
    expect(q.error).toMatch(/does not ship/i);
  });

  it('pickup is always free', () => {
    expect(
      quoteShipping({
        store,
        zones,
        buyer: { country: 'China' },
        preferredMode: 'pickup',
      }),
    ).toMatchObject({ ok: true, mode: 'pickup', fee: 0 });
  });
});

describe('sanitizeZoneInput', () => {
  it('builds country and city rows', () => {
    expect(sanitizeZoneInput({ country: 'Canada', fee: 5 })).toMatchObject({
      match_type: 'country',
      country: 'Canada',
      city: null,
      fee: 5,
    });
    expect(sanitizeZoneInput({ country: 'Canada', city: 'Toronto', fee: 3, name: 'TO' })).toMatchObject({
      match_type: 'city',
      city: 'Toronto',
      name: 'TO',
    });
  });

  it('rejects invalid rows', () => {
    expect(sanitizeZoneInput({ country: '', fee: 5 })).toBeNull();
    expect(sanitizeZoneInput({ country: 'CA', fee: -1 })).toBeNull();
  });
});
