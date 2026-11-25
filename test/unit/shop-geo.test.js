import { describe, it, expect } from 'vitest';
import {
  buildPublicShopGeoSellerFilter,
  listingWithinShopGeoRadius,
  rankListingsForShopGeo,
  haversineKm,
} from '../../utils/shop-geo.js';

const BUYER = [43.65, -79.38];               // Toronto
const near = (id) => ({ listing_id: id, seller: { storeProfile: { lat: 43.66, lng: -79.39, is_active: true } } });
const far = (id) => ({ listing_id: id, seller: { storeProfile: { lat: 0, lng: 0, is_active: true } } });
const noProfile = (id) => ({ listing_id: id, seller: { storeProfile: null } });
const noCoords = (id) => ({ listing_id: id, seller: { storeProfile: { lat: null, lng: null, is_active: true } } });
const closed = (id) => ({ listing_id: id, seller: { storeProfile: { lat: 43.66, lng: -79.39, is_active: false } } });
const ids = (rows) => rows.map((r) => r.listing_id);

describe('buildPublicShopGeoSellerFilter', () => {
  it('returns null without finite coords', () => {
    expect(buildPublicShopGeoSellerFilter(NaN, -79)).toBeNull();
  });

  // The regression this guards. A to-one relation filter (storeProfile: { is: {...} }) requires the
  // related row to EXIST, so the old single-branch filter silently excluded every seller who had no
  // storeProfile — or had one with null coords. Their products vanished for any located buyer.
  it('keeps coord-less sellers in the query instead of excluding them', () => {
    const filter = buildPublicShopGeoSellerFilter(...BUYER, 20);
    expect(Array.isArray(filter.OR)).toBe(true);

    const branches = JSON.stringify(filter.OR);
    expect(branches).toContain('"is":null');       // no storeProfile at all
    expect(branches).toContain('"lat":null');      // profile, never geocoded
    expect(branches).toContain('"lng":null');
  });

  it('still bounds located stores to a box around the buyer', () => {
    const filter = buildPublicShopGeoSellerFilter(...BUYER, 20);
    const box = filter.OR.find((b) => b.storeProfile?.is?.lat?.gte !== undefined);
    expect(box.storeProfile.is.is_active).toBe(true);
    expect(box.storeProfile.is.lat.gte).toBeLessThan(43.65);
    expect(box.storeProfile.is.lat.lte).toBeGreaterThan(43.65);
    expect(box.storeProfile.is.lng.gte).toBeLessThan(-79.38);
  });
});

describe('listingWithinShopGeoRadius', () => {
  it('is true only for a LOCATED, active, in-range store', () => {
    expect(listingWithinShopGeoRadius(near(1), ...BUYER)).toBe(true);
  });

  it('is false for far, closed, or unlocated stores', () => {
    expect(listingWithinShopGeoRadius(far(1), ...BUYER)).toBe(false);
    expect(listingWithinShopGeoRadius(closed(1), ...BUYER)).toBe(false);
    expect(listingWithinShopGeoRadius(noProfile(1), ...BUYER)).toBe(false);
    expect(listingWithinShopGeoRadius(noCoords(1), ...BUYER)).toBe(false);
  });
});

describe('rankListingsForShopGeo', () => {
  // The actual fix. A seller who never set their store location must stay FINDABLE — just never
  // ahead of a shop that is genuinely nearby. Dropping them meant their storefront disappeared for
  // every located buyer while their own dashboard looked perfectly healthy and nothing was logged.
  it('keeps coord-less sellers, ranked after the nearby ones', () => {
    const out = rankListingsForShopGeo([noProfile(1), near(2), noCoords(3)], ...BUYER);
    expect(ids(out)).toEqual([2, 1, 3]);
  });

  it('still drops sellers who ARE located but genuinely far away', () => {
    // "We don't know where you are" and "we know, and you're far" are different things.
    const out = rankListingsForShopGeo([far(1), near(2), noCoords(3)], ...BUYER);
    expect(ids(out)).toEqual([2, 3]);
  });

  it('keeps deactivated stores hidden, coords or not', () => {
    const closedNoCoords = { listing_id: 9, seller: { storeProfile: { lat: null, lng: null, is_active: false } } };
    const out = rankListingsForShopGeo([closed(1), closedNoCoords, near(2)], ...BUYER);
    expect(ids(out)).toEqual([2]);
  });

  it('preserves the incoming relevance order within each group', () => {
    const out = rankListingsForShopGeo([noCoords(1), near(2), noProfile(3), near(4)], ...BUYER);
    expect(ids(out)).toEqual([2, 4, 1, 3]);   // nearby (in order), then unlocated (in order)
  });

  it('handles an empty/garbage list without throwing', () => {
    expect(rankListingsForShopGeo([], ...BUYER)).toEqual([]);
    expect(rankListingsForShopGeo(null, ...BUYER)).toEqual([]);
  });
});

describe('haversineKm', () => {
  it('returns ~0 for identical points', () => {
    expect(haversineKm(43.65, -79.38, 43.65, -79.38)).toBeCloseTo(0, 5);
  });
});
