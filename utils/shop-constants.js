/**
 * Shop commerce constants shared across API routes.
 * Keep aligned with frontend `src/utils/shopMappers.js` (SHOP_* exports).
 */

/** Radius pushed into SQL bounding-box + haversine pass for public browse. */
export const SHOP_API_GEO_RADIUS_KM = 20;

/** Recommended client-side cap when displaying distance-sorted shops. */
export const SHOP_MAX_BROWSE_DISTANCE_KM = 50;

/** Safety cap on public product_listing discovery scans (unbounded browse). */
export const SHOP_LISTINGS_PUBLIC_CAP = 500;

/** Default local courier fee when quote falls back without zones. */
export const DEFAULT_DELIVERY_FEE = 1.99;

/** Default global ship-by-seller fee when no zone matches and no zones configured (legacy). */
export const DEFAULT_SHIP_BY_SELLER_FEE = 4.99;
