import { capacityAttrFor } from './booking-capacity.js';

/**
 * Parse public GET /booking/listings filter query params (Phase 4).
 * Returns only validated fields safe to merge into a Prisma where clause.
 */

export function parseListingBrowseFilters(query = {}, vertical = null) {
  const out = {};
  const minPrice = query.min_price != null && query.min_price !== '' ? Number(query.min_price) : null;
  const maxPrice = query.max_price != null && query.max_price !== '' ? Number(query.max_price) : null;
  const minGuests = query.min_guests != null && query.min_guests !== '' ? Number(query.min_guests) : null;

  if (Number.isFinite(minPrice) && minPrice >= 0) {
    out.price = { ...(out.price || {}), gte: minPrice };
  }
  if (Number.isFinite(maxPrice) && maxPrice >= 0) {
    out.price = { ...(out.price || {}), lte: maxPrice };
  }
  // min_guests maps to capacity (concurrent units / max guests for date-range verticals).
  // Vehicle passenger counts live in attributes.seats — never route min_guests here for vehicle.
  // min_guests <= 1 is a no-op: default browse must not hide NULL-capacity listings
  // (Prisma { gte: 1 } excludes NULL Int? rows).
  if (Number.isFinite(minGuests) && minGuests > 1) {
    const attr = capacityAttrFor(vertical);
    if (attr) {
      // Single-unit verticals pin capacity to 1, so filtering the column would match
      // nothing. The people-count lives in attributes instead.
      out.attributes = { path: [attr], gte: Math.floor(minGuests) };
    } else {
      out.capacity = { gte: Math.floor(minGuests) };
    }
  }
  return out;
}
