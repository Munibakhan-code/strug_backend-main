/**
 * Seller shipping zones — hybrid local delivery vs ship-by-seller quotes.
 */

import {
  SHOP_API_GEO_RADIUS_KM,
  DEFAULT_DELIVERY_FEE,
  DEFAULT_SHIP_BY_SELLER_FEE,
} from './shop-constants.js';
import { haversineKm } from './shop-geo.js';

export const DEFAULT_LOCAL_RADIUS_KM = SHOP_API_GEO_RADIUS_KM;

export function normalizePlaceKey(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** True when buyer coords fall within the store's local delivery radius. */
export function isBuyerLocalToStore(buyerLat, buyerLng, store, radiusKm = DEFAULT_LOCAL_RADIUS_KM) {
  const slat = store?.lat;
  const slng = store?.lng;
  if (
    !Number.isFinite(buyerLat) ||
    !Number.isFinite(buyerLng) ||
    !Number.isFinite(slat) ||
    !Number.isFinite(slng)
  ) {
    return false;
  }
  const dist = haversineKm(buyerLat, buyerLng, slat, slng);
  return dist != null && dist <= (Number(radiusKm) || DEFAULT_LOCAL_RADIUS_KM);
}

/**
 * Pick the best active zone for destination.
 * Prefer city matches over country matches; then lower priority wins.
 */
export function matchShippingZone(zones, { country, city } = {}) {
  const list = (Array.isArray(zones) ? zones : []).filter((z) => z?.is_active !== false);
  const wantCountry = normalizePlaceKey(country);
  const wantCity = normalizePlaceKey(city);
  if (!wantCountry) return null;

  const countryMatches = list.filter(
    (z) => normalizePlaceKey(z.country) === wantCountry,
  );
  if (!countryMatches.length) return null;

  if (wantCity) {
    const cityHit = countryMatches
      .filter(
        (z) =>
          (z.match_type === 'city' || z.city) &&
          normalizePlaceKey(z.city) === wantCity,
      )
      .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    if (cityHit[0]) return cityHit[0];
  }

  const countryOnly = countryMatches
    .filter((z) => z.match_type !== 'city' && !z.city)
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

  return countryOnly[0] || null;
}

/**
 * Quote fulfillment mode + fee for a buyer destination.
 *
 * @returns {{
 *   ok: boolean,
 *   local: boolean,
 *   mode: 'delivery'|'ship_by_seller'|'pickup'|null,
 *   fee: number|null,
 *   zone_id: number|null,
 *   error?: string,
 * }}
 */
export function quoteShipping({
  store,
  zones,
  buyer = {},
  preferredMode = null,
  localRadiusKm = DEFAULT_LOCAL_RADIUS_KM,
} = {}) {
  if (preferredMode === 'pickup') {
    return { ok: true, local: true, mode: 'pickup', fee: 0, zone_id: null };
  }

  const local = isBuyerLocalToStore(
    buyer.lat,
    buyer.lng,
    store,
    localRadiusKm,
  );

  if (local && preferredMode !== 'ship_by_seller') {
    return {
      ok: true,
      local: true,
      mode: 'delivery',
      fee: DEFAULT_DELIVERY_FEE,
      zone_id: null,
    };
  }

  const zone = matchShippingZone(zones, {
    country: buyer.country,
    city: buyer.city,
  });

  if (!zone) {
    const hasZones = (Array.isArray(zones) ? zones : []).some((z) => z?.is_active !== false);
    // No zones configured yet: keep legacy flat fees (delivery or ship-by-seller).
    if (!hasZones) {
      if (preferredMode === 'delivery') {
        return {
          ok: true,
          local: false,
          mode: 'delivery',
          fee: DEFAULT_DELIVERY_FEE,
          zone_id: null,
        };
      }
      if (!buyer.country) {
        return {
          ok: false,
          local: false,
          mode: null,
          fee: null,
          zone_id: null,
          error: 'Add a country to your address before checkout',
        };
      }
      return {
        ok: true,
        local: false,
        mode: 'ship_by_seller',
        fee: DEFAULT_SHIP_BY_SELLER_FEE,
        zone_id: null,
      };
    }
    return {
      ok: false,
      local: false,
      mode: null,
      fee: null,
      zone_id: null,
      error: 'This seller does not ship to your location',
    };
  }

  return {
    ok: true,
    local: false,
    mode: 'ship_by_seller',
    fee: Math.max(0, Number(zone.fee) || 0),
    zone_id: zone.zone_id ?? zone.id ?? null,
  };
}

/** Normalize seller dashboard zone rows before persist. */
export function sanitizeZoneInput(row, index = 0) {
  const country = String(row?.country ?? '').trim();
  const city = String(row?.city ?? '').trim() || null;
  const fee = Number(row?.fee);
  if (!country || !Number.isFinite(fee) || fee < 0) return null;
  const match_type = city ? 'city' : 'country';
  return {
    name: String(row?.name || `${country}${city ? ` / ${city}` : ''}`).trim().slice(0, 120),
    match_type,
    country: country.slice(0, 120),
    city: city ? city.slice(0, 120) : null,
    fee,
    priority: Number.isFinite(Number(row?.priority)) ? Number(row.priority) : 100 + index,
    is_active: row?.is_active !== false,
  };
}
