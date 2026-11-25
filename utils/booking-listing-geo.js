/**
 * Geo helpers for GET /booking/listings (Medical Phase 2 near-me / radius).
 * Haversine post-filter — Prisma has no built-in radius operator here.
 */

const EARTH_RADIUS_KM = 6371;

export function haversineKm(lat1, lon1, lat2, lon2) {
  const la1 = Number(lat1);
  const lo1 = Number(lon1);
  const la2 = Number(lat2);
  const lo2 = Number(lon2);
  if (![la1, lo1, la2, lo2].every(Number.isFinite)) return null;
  const dLat = ((la2 - la1) * Math.PI) / 180;
  const dLon = ((lo2 - lo1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2
    + Math.cos((la1 * Math.PI) / 180) * Math.cos((la2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * @returns {{ lat: number, lng: number, radiusKm: number } | null}
 */
export function parseListingGeoQuery(query = {}) {
  const lat = query.lat != null && query.lat !== '' ? Number(query.lat) : null;
  const lng = query.lng != null && query.lng !== '' ? Number(query.lng) : (
    query.long != null && query.long !== '' ? Number(query.long) : null
  );
  const radiusKm = query.radius_km != null && query.radius_km !== ''
    ? Number(query.radius_km)
    : (query.radiusKm != null && query.radiusKm !== '' ? Number(query.radiusKm) : null);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (!Number.isFinite(radiusKm) || radiusKm <= 0) return null;
  return { lat, lng, radiusKm: Math.min(radiusKm, 500) };
}

/**
 * Keep listings with coordinates inside radiusKm of origin.
 * Listings without lat/lng are excluded when a geo filter is active.
 */
export function filterListingsByRadius(listings, geo) {
  if (!geo) return Array.isArray(listings) ? listings : [];
  const list = Array.isArray(listings) ? listings : [];
  return list
    .map((row) => {
      const distance_km = haversineKm(geo.lat, geo.lng, row?.latitude, row?.longitude);
      return { ...row, distance_km };
    })
    .filter((row) => row.distance_km != null && row.distance_km <= geo.radiusKm);
}
