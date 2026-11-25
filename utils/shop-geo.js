/**
 * Shop Phase 7 — public listing geo helpers.
 *
 * When the buyer has a location, nearby stores win. But a seller who never set store coordinates
 * must NOT be erased from the storefront — Phase 7 dropped them entirely, and that is a bug waiting
 * for its first seller: their products vanish for every located buyer, their own dashboard still
 * shows the store as fine, nothing is logged anywhere, and it only reproduces if whoever
 * investigates happens to have a location set too. Silent, total, and horrible to diagnose.
 *
 * So coord-less sellers are KEPT and simply RANKED LAST — visible, just never preferred over a store
 * that is actually near you. A seller with coords who is genuinely far away is still excluded; that
 * is the point of a geo filter. The distinction that matters is "we don't know where you are" versus
 * "we know, and you're far".
 */

import { SHOP_API_GEO_RADIUS_KM } from './shop-constants.js';

export function haversineKm(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Prisma `seller` filter for a located buyer: stores inside the ~radiusKm bounding box, PLUS stores
 * with no coordinates at all (those are ranked last post-fetch, not dropped).
 *
 * NOTE the shape. A to-one relation filter (`storeProfile: { is: {...} }`) requires the related row
 * to EXIST — a seller with no storeProfile is silently excluded by it, which is exactly how the
 * coord-less seller vanished. The `{ is: null }` branch is what puts them back.
 *
 * Deactivated stores (`is_active: false`) stay hidden in every branch — #348.
 */
export function buildPublicShopGeoSellerFilter(
  userLat,
  userLng,
  radiusKm = SHOP_API_GEO_RADIUS_KM,
) {
  if (!Number.isFinite(userLat) || !Number.isFinite(userLng)) return null;
  const latDelta = radiusKm / 111;
  const lngDelta = radiusKm / Math.max(1, 111 * Math.cos((userLat * Math.PI) / 180));
  return {
    OR: [
      // No store profile at all — nothing to locate. Keep (ranked last).
      { storeProfile: { is: null } },
      // Has a profile but never set coordinates. Keep (ranked last).
      { storeProfile: { is: { is_active: true, lat: null } } },
      { storeProfile: { is: { is_active: true, lng: null } } },
      // Located, and inside the bounding box. The exact circle is applied post-fetch.
      {
        storeProfile: {
          is: {
            is_active: true,
            lat: { gte: userLat - latDelta, lte: userLat + latDelta },
            lng: { gte: userLng - lngDelta, lte: userLng + lngDelta },
          },
        },
      },
    ],
  };
}

/** The seller's store profile, but only when it carries usable coordinates. */
function locatedStoreOf(item) {
  const p = item?.seller?.storeProfile;
  if (!p || p.lat == null || p.lng == null) return null;
  return p;
}

/** Post-fetch exact circle — true only for a LOCATED store that is genuinely within range. */
export function listingWithinShopGeoRadius(item, userLat, userLng, radiusKm = SHOP_API_GEO_RADIUS_KM) {
  const profile = locatedStoreOf(item);
  if (!profile) return false;
  if (profile.is_active === false) return false;
  const dist = haversineKm(userLat, userLng, profile.lat, profile.lng);
  return dist !== null && dist <= radiusKm;
}

/**
 * Order listings for a located buyer: in-range stores first (their existing relevance order is
 * preserved), then the coord-less ones. Stores that HAVE coords but sit out of range are dropped.
 *
 * Ranking rather than filtering IS the fix: a seller who skipped the location field stays findable,
 * just never ahead of a shop that is actually nearby.
 */
export function rankListingsForShopGeo(items, userLat, userLng, radiusKm = SHOP_API_GEO_RADIUS_KM) {
  const nearby = [];
  const unlocated = [];

  for (const item of Array.isArray(items) ? items : []) {
    if (locatedStoreOf(item)) {
      // Located: in range or not for this buyer at all.
      if (listingWithinShopGeoRadius(item, userLat, userLng, radiusKm)) nearby.push(item);
      continue;
    }
    // Unlocated. A deactivated store stays hidden even without coords (#348).
    if (item?.seller?.storeProfile?.is_active === false) continue;
    unlocated.push(item);
  }

  return [...nearby, ...unlocated];
}
