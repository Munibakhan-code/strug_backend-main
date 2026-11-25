/**
 * Reservation listing configuration helpers.
 *
 * The booking engine treats:
 *   - listing.capacity / attributes.max_guests  → max party size per booking
 *   - attributes.tables                         → concurrent parties (primary inventory)
 *   - attributes.seating_capacity               → optional total seats across overlapping turns
 *     (additional constraint — does not replace tables when both are set)
 *   - attributes.turn_time_minutes              → seating window length
 *   - attributes.time_slots / service_hours /
 *     reservation_hours                         → host-defined bookable hours/slots
 *
 * Computed response fields (booked_today) must never be persisted.
 */

export const RESERVATION_COMPUTED_ATTR_KEYS = Object.freeze(['booked_today']);

export const RESERVATION_PROTECTED_ATTR_KEYS = Object.freeze([
  'time_slots',
  'food_vendor_id',
  'seating_capacity',
  'tables',
  'turn_time_minutes',
  'turn_minutes',
  'service_hours',
  'reservation_hours',
  'max_guests',
]);

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function positiveInt(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Strip response-only / computed keys before persisting attributes. */
export function stripComputedReservationAttributes(attributes) {
  const next = { ...asObject(attributes) };
  for (const key of RESERVATION_COMPUTED_ATTR_KEYS) delete next[key];
  return next;
}

/**
 * Merge reservation attributes on update so partial client payloads cannot erase
 * engine config (time_slots, food_vendor_id, seating_capacity, etc.).
 */
export function mergeReservationAttributes(existingAttributes, incomingAttributes) {
  const existing = stripComputedReservationAttributes(existingAttributes);
  if (incomingAttributes === undefined) {
    return existing;
  }
  const incoming = stripComputedReservationAttributes(incomingAttributes);
  const merged = { ...existing, ...incoming };

  // Preserve protected keys when the client omits them or sends null/empty.
  for (const key of RESERVATION_PROTECTED_ATTR_KEYS) {
    const incomingHasKey = Object.prototype.hasOwnProperty.call(incoming, key);
    const incomingVal = incoming[key];
    const empty =
      incomingVal == null
      || incomingVal === ''
      || (Array.isArray(incomingVal) && incomingVal.length === 0);
    if ((!incomingHasKey || empty) && existing[key] != null && existing[key] !== '') {
      merged[key] = existing[key];
    }
  }
  return merged;
}

/**
 * Validate reservation listing capacity/config for create/update.
 * Returns { ok: true, capacity, attributes } or { ok: false, message }.
 */
export function validateReservationListingConfig({
  capacity,
  attributes,
  existingAttributes = null,
  isUpdate = false,
} = {}) {
  const attrs = isUpdate
    ? mergeReservationAttributes(existingAttributes, attributes)
    : stripComputedReservationAttributes(attributes);

  const maxParty = positiveInt(capacity) ?? positiveInt(attrs.max_guests);
  if (!maxParty) {
    if (capacity === 0 || attrs.max_guests === 0) {
      return {
        ok: false,
        message: 'Reservation party size capacity must be greater than 0',
      };
    }
    return {
      ok: false,
      message: 'Reservation listings require party size capacity (capacity or attributes.max_guests)',
    };
  }

  const seating = positiveInt(attrs.seating_capacity);
  const tables = positiveInt(attrs.tables);
  if (!seating && !tables) {
    if (attrs.seating_capacity === 0 || attrs.tables === 0) {
      return {
        ok: false,
        message: 'Reservation seating capacity / tables must be greater than 0',
      };
    }
    return {
      ok: false,
      message: 'Reservation listings require concurrent capacity (attributes.seating_capacity or attributes.tables)',
    };
  }

  const turn = positiveInt(attrs.turn_time_minutes ?? attrs.turn_minutes);
  if (!turn) {
    if (attrs.turn_time_minutes === 0 || attrs.turn_minutes === 0) {
      return {
        ok: false,
        message: 'Reservation turn time must be greater than 0 minutes',
      };
    }
    return {
      ok: false,
      message: 'Reservation listings require turn_time_minutes (or turn_minutes)',
    };
  }

  // Prefer canonical turn_time_minutes going forward.
  attrs.turn_time_minutes = turn;
  if (attrs.max_guests == null) attrs.max_guests = maxParty;

  return {
    ok: true,
    capacity: maxParty,
    attributes: attrs,
  };
}
