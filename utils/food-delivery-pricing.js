import { getDistanceMatrix, geocodeAddress } from './google-maps.js';

export function readNonNegativeEnvNumber(name, fallback) {
  if (process.env[name] == null || process.env[name] === '') return fallback;
  const parsed = Number.parseFloat(process.env[name]);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  console.warn(`[food-orders] Ignoring invalid ${name}=${process.env[name]}; using ${fallback}.`);
  return fallback;
}

export const FOOD_DELIVERY_FEE_PER_KM = readNonNegativeEnvNumber('FOOD_DELIVERY_FEE_PER_KM', 2.5);
export const FOOD_DELIVERY_BASE_FEE = readNonNegativeEnvNumber('FOOD_DELIVERY_BASE_FEE', 0);
/** Max road/air distance (km) for courier food delivery — rejects Lahore→Toronto style mismatches. */
export const FOOD_DELIVERY_MAX_KM = readNonNegativeEnvNumber('FOOD_DELIVERY_MAX_KM', 25);

export function parseNonNegativeAmount(value) {
  if (value == null || value === '') return undefined;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

/**
 * Parse a latitude/longitude from a request body.
 * Never use Number(null) — that becomes 0 and invents "Null Island" (0,0),
 * which previously produced ~8328 km false "too far" rejections.
 */
export function parseFiniteCoord(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** True only for real map points — rejects missing values and Null Island (0,0). */
export function isUsableLatLng(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (Math.abs(lat) < 1e-6 && Math.abs(lng) < 1e-6) return false;
  return true;
}

export function calculateFoodDeliveryFee(distanceMeters) {
  const meters = Number(distanceMeters);
  if (!Number.isFinite(meters) || meters < 0) return null;
  return Number(((meters / 1000) * FOOD_DELIVERY_FEE_PER_KM).toFixed(2));
}

export function fallbackFoodDeliveryFee(reason, fallbackFee = FOOD_DELIVERY_BASE_FEE) {
  const parsedFallback = parseNonNegativeAmount(fallbackFee);
  const resolvedFallback = parsedFallback == null ? FOOD_DELIVERY_BASE_FEE : parsedFallback;
  console.warn(`[food-orders] Falling back to delivery fee (${resolvedFallback}) because ${reason}.`);
  return Number(resolvedFallback.toFixed(2));
}

export async function resolveFoodDeliveryFee({ vendorLocation, deliverLocation, fallbackFee }) {
  if (!vendorLocation || !deliverLocation) {
    return fallbackFoodDeliveryFee("vendor or delivery location is missing", fallbackFee);
  }
  const matrix = await getDistanceMatrix(vendorLocation, deliverLocation);
  const deliveryFee = calculateFoodDeliveryFee(matrix?.distance?.value);
  if (deliveryFee == null) {
    return fallbackFoodDeliveryFee("distance matrix did not return a usable distance", fallbackFee);
  }
  return deliveryFee;
}

function haversineKm(vLat, vLng, dLat, dLng) {
  const R = 6371;
  const dLatR = ((dLat - vLat) * Math.PI) / 180;
  const dLonR = ((dLng - vLng) * Math.PI) / 180;
  const a =
    Math.sin(dLatR / 2) ** 2 +
    Math.cos((vLat * Math.PI) / 180) * Math.cos((dLat * Math.PI) / 180) * Math.sin(dLonR / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function tooFarResult(distanceKm, max) {
  return {
    ok: false,
    distanceKm,
    message: `This address is too far for courier delivery (${distanceKm.toFixed(1)} km). Choose a closer address or Self-Pickup (max ${max} km).`,
  };
}

/**
 * Guard courier deliveries to a local radius. Uses Distance Matrix meters when available;
 * otherwise Haversine between lat/lng pairs (geocoding address text when coords are missing).
 * Returns { ok: true } or { ok: false, message, distanceKm }.
 */
export async function assertFoodDeliveryInRange({
  vendorLocation,
  deliverLocation,
  vendorLat,
  vendorLong,
  deliverLat,
  deliverLng,
  maxKm = FOOD_DELIVERY_MAX_KM,
}) {
  const limit = Number(maxKm);
  const max = Number.isFinite(limit) && limit > 0 ? limit : FOOD_DELIVERY_MAX_KM;

  if (vendorLocation && deliverLocation) {
    const matrix = await getDistanceMatrix(vendorLocation, deliverLocation);
    const meters = matrix?.distance?.value;
    if (Number.isFinite(meters) && meters >= 0) {
      const distanceKm = meters / 1000;
      if (distanceKm > max) return tooFarResult(distanceKm, max);
      return { ok: true, distanceKm };
    }
  }

  let vLat = parseFiniteCoord(vendorLat);
  let vLng = parseFiniteCoord(vendorLong);
  let dLat = parseFiniteCoord(deliverLat);
  let dLng = parseFiniteCoord(deliverLng);

  if (!isUsableLatLng(vLat, vLng) && vendorLocation) {
    const geo = await geocodeAddress(String(vendorLocation).trim());
    if (geo && isUsableLatLng(geo.lat, geo.lng)) {
      vLat = geo.lat;
      vLng = geo.lng;
    }
  }
  if (!isUsableLatLng(dLat, dLng) && deliverLocation) {
    const geo = await geocodeAddress(String(deliverLocation).trim());
    if (geo && isUsableLatLng(geo.lat, geo.lng)) {
      dLat = geo.lat;
      dLng = geo.lng;
    }
  }

  if (isUsableLatLng(vLat, vLng) && isUsableLatLng(dLat, dLng)) {
    const distanceKm = haversineKm(vLat, vLng, dLat, dLng);
    if (distanceKm > max) return tooFarResult(distanceKm, max);
    return { ok: true, distanceKm };
  }

  // Without usable distance data we cannot hard-block — fee path already falls back.
  // Never invent (0,0) from null coords; that falsely rejected local Pakistan deliveries.
  return { ok: true, distanceKm: null };
}
