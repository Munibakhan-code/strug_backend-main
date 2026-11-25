/**
 * `booking_listing.capacity` means CONCURRENT BOOKABLE UNITS to the availability engine:
 * `checkAvailability` permits overlapping bookings while `used < capacity` (hotel rooms,
 * copies of an equipment item).
 *
 * Some verticals are a SINGLE physical thing that happens to hold N people — a cottage that
 * sleeps 4, a car with 5 seats. Their host forms labelled the capacity box "Max guests" /
 * "Seats", so a party size was being written into a units column, and the engine read it back
 * as "this listing can be booked 4 times over the same dates". A host who listed a 4-guest
 * cottage was accepting four simultaneous bookings for it.
 *
 * Fix: for these verticals capacity is pinned to 1, and the human number lives in
 * `attributes.<attr>` where the guest surfaces already look for it.
 *
 * Adding a new vertical? If its capacity field describes PEOPLE rather than INVENTORY
 * (cottage guests, car seats, venue attendees — including price_unit event), add it here.
 * checkAvailability pins capacity to 1 for both date-range and single-day branches.
 */
export const SINGLE_UNIT_CAPACITY_ATTR = Object.freeze({
  tempstay: 'max_guests',
  vehicle: 'seats',
  // Venue "Max attendees" is people, not concurrent same-day bookings.
  venue: 'max_attendees',
  // Wedding venues/packages: guest count is people, not inventory units.
  wedding: 'max_attendees',
});

/** True when `capacity` on this vertical must be 1 (one physical unit). */
export function isSingleUnitVertical(vertical) {
  return Object.prototype.hasOwnProperty.call(SINGLE_UNIT_CAPACITY_ATTR, vertical);
}

/** The attributes key holding the people-count for this vertical, or null. */
export function capacityAttrFor(vertical) {
  return SINGLE_UNIT_CAPACITY_ATTR[vertical] ?? null;
}

/**
 * Normalize a listing write for a single-unit vertical.
 *
 * Returns `{ capacity, attributes }` with capacity forced to 1 and the incoming people-count
 * rescued into `attributes.<attr>` when it isn't already recorded. The rescue matters because
 * the two host forms disagree: BookingListingForm posts `capacity`, while the seller dashboard
 * posts `attributes.max_guests`. Without it, a client still sending the old shape would have
 * its guest count silently dropped on the floor the moment this ships.
 *
 * Pass `incoming.capacity === undefined` for a PATCH-style update that didn't touch capacity —
 * the pin is still applied, since it must hold for every row of these verticals.
 */
export function normalizeSingleUnitCapacity(vertical, incoming = {}, existingAttributes = null) {
  const attr = capacityAttrFor(vertical);
  if (!attr) return null;

  const base = incoming.attributes !== undefined ? incoming.attributes : existingAttributes;
  const attributes = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {};

  const people = Number(incoming.capacity);
  const alreadyRecorded = attributes[attr] != null && attributes[attr] !== '';
  if (!alreadyRecorded && Number.isFinite(people) && people > 1) {
    attributes[attr] = Math.floor(people);
  }

  return { capacity: 1, attributes };
}

/**
 * Validate the people count on a booking against attributes.<attr>.
 * `capacity` is pinned to 1 for these verticals, so it cannot be used here.
 */
export function validatePartySize(listing, guests) {
  const attr = capacityAttrFor(listing?.vertical);
  if (!attr) return null;

  const value = Number(guests);
  if (!Number.isInteger(value) || value < 1) return 'Guest count must be at least 1';

  const attrs = listing?.attributes;
  const max = Number(attrs && typeof attrs === 'object' ? attrs[attr] : null);
  if (Number.isFinite(max) && max > 0 && value > max) {
    return `This listing allows up to ${Math.floor(max)} guests`;
  }
  return null;
}
