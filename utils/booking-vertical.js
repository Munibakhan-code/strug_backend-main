/**
 * Booking-engine vertical helpers — shared by routes and unit tests.
 * Isolation rule: host portals and guest surfaces must filter by vertical
 * on the server (never FE-only) so multi-vertical hosts don't bleed data.
 */

export const KNOWN_BOOKING_VERTICALS = Object.freeze([
  'tempstay',
  'hotel',
  'venue',
  'equipment',
  'vehicle',
  'lesson',
  'event',
  'experience',
  'celebrity',
  'artist',
  'reservation',
  'influencer',
  'artwork',
  'wedding',
  'professional',
  'mechanic',
  'decor',
  'medical',
]);

const KNOWN_SET = new Set(KNOWN_BOOKING_VERTICALS);

/** True when name is a known booking-engine vertical. */
export function isKnownBookingVertical(name) {
  if (name == null || name === '') return false;
  return KNOWN_SET.has(String(name).trim());
}

/**
 * Parse an optional `vertical` query/body value.
 * @returns {{ ok: true, vertical: string|null } | { ok: false, error: string }}
 *   - missing/empty → ok, vertical null (unscoped — callers decide if that is allowed)
 *   - known value → ok, vertical string
 *   - unknown value → not ok
 */
export function parseBookingVertical(raw) {
  if (raw == null || raw === '') {
    return { ok: true, vertical: null };
  }
  const vertical = String(raw).trim();
  if (!vertical) return { ok: true, vertical: null };
  if (!KNOWN_SET.has(vertical)) {
    return { ok: false, error: `Unknown vertical "${vertical}"` };
  }
  return { ok: true, vertical };
}

/**
 * Build a Prisma where fragment for optional vertical scoping.
 * Returns {} when vertical is null/omitted.
 */
export function verticalWhereClause(vertical) {
  if (!vertical) return {};
  return { vertical };
}
