import { findVendorTypeIdsByNames } from './vendor-type.js';

/**
 * Food order fulfillment is a create-time fact (pickup vs courier delivery).
 * It lives on food_order.fulfillment_mode so a customer cannot flip it by
 * writing deliver_location. The __SELF_PICKUP__ address sentinel is still
 * persisted for older UIs, but it is never the source of truth for dispatch.
 */

export const FOOD_SELF_PICKUP_SENTINEL = '__SELF_PICKUP__';
export const FOOD_FULFILLMENT_PICKUP = 'pickup';
export const FOOD_FULFILLMENT_DELIVERY = 'delivery';

export function isReservedPickupSentinel(value) {
  return String(value ?? '').trim() === FOOD_SELF_PICKUP_SENTINEL;
}

export function normalizeFulfillmentMode(raw) {
  const mode = String(raw || '').trim().toLowerCase();
  return mode === FOOD_FULFILLMENT_PICKUP ? FOOD_FULFILLMENT_PICKUP : FOOD_FULFILLMENT_DELIVERY;
}

/**
 * Prisma `where` that selects courier-dispatchable food rows.
 * Use `NOT: { deliver_location: sentinel }` (not `deliver_location: { not }`) so
 * legacy NULL-address delivery rows are kept — Prisma `not` on String? is NULL
 * for those rows and would drop them from the pool.
 *
 * Catering is a venue drop by the caterer, not a same-day courier job. Pass
 * cateringTypeIds from findVendorTypeIdsByNames. A bare `notIn` would drop
 * NULL vendor_type_id rows, so keep those with an OR.
 */
export function foodCourierDispatchWhere({ cateringTypeIds = [] } = {}) {
  const where = {
    fulfillment_mode: FOOD_FULFILLMENT_DELIVERY,
    NOT: { deliver_location: FOOD_SELF_PICKUP_SENTINEL },
  };
  if (!cateringTypeIds.length) return where;
  return {
    ...where,
    OR: [
      { vendor_type_id: null },
      { vendor_type_id: { notIn: cateringTypeIds } },
    ],
  };
}

/** Resolve catering vendor_type ids then build the courier-pool `where`. */
export async function resolveFoodCourierDispatchWhere(db) {
  const cateringTypeIds = await findVendorTypeIdsByNames(db, ['Catering']);
  return foodCourierDispatchWhere({ cateringTypeIds });
}

/** True when the guest chose Self-Pickup (no courier). Delivery is the default for legacy rows. */
export function isFoodPickupOrder(order) {
  const mode = String(order?.fulfillment_mode || '').trim().toLowerCase();
  if (mode === FOOD_FULFILLMENT_PICKUP) return true;
  if (mode === FOOD_FULFILLMENT_DELIVERY) return false;
  if (isReservedPickupSentinel(order?.deliver_location)) return true;
  const loc = String(order?.deliver_location || '').trim();
  // A real delivery address means courier delivery, even if the fee happens to be zero.
  if (loc) return false;
  // Legacy heuristic: empty location + zero fee + no courier ≈ self-pickup.
  return Number(order?.delivery_fee || 0) === 0 && order?.driver_id == null;
}

/** Persistable location value — self-pickup uses a sentinel so seller/driver UIs can branch. */
export function persistDeliverLocation(fulfillmentMode, deliverLocation) {
  if (normalizeFulfillmentMode(fulfillmentMode) === FOOD_FULFILLMENT_PICKUP) {
    return FOOD_SELF_PICKUP_SENTINEL;
  }
  const loc = deliverLocation == null ? null : String(deliverLocation).trim() || null;
  if (isReservedPickupSentinel(loc)) return null;
  return loc;
}

/** Customer/driver-facing location — never leak the internal self-pickup sentinel. */
export function publicDeliverLocation(order) {
  const loc = typeof order === 'string' || order == null
    ? order
    : order?.deliver_location;
  if (loc == null) return null;
  if (isReservedPickupSentinel(loc)) return null;
  return loc;
}

/** Fulfillment mode is set at create and cannot be changed afterwards. */
export function assertFulfillmentLocked(existing, requestedMode) {
  if (requestedMode === undefined || requestedMode === null || String(requestedMode).trim() === '') {
    return { ok: true };
  }
  const next = normalizeFulfillmentMode(requestedMode);
  const current = isFoodPickupOrder(existing) ? FOOD_FULFILLMENT_PICKUP : FOOD_FULFILLMENT_DELIVERY;
  if (next !== current) {
    return {
      ok: false,
      status: 403,
      message: 'Fulfillment mode cannot be changed after the order is created.',
    };
  }
  return { ok: true };
}

/**
 * Address edits must not convert pickup ↔ delivery (the column is the lock).
 * Pickup rows keep the sentinel; delivery rows cannot be written as the sentinel.
 */
export function sanitizeDeliverLocationUpdate(existing, requestedLocation) {
  if (requestedLocation === undefined) return { ok: true };
  if (isFoodPickupOrder(existing)) {
    return {
      ok: false,
      status: 403,
      message: 'Self-pickup orders cannot change delivery address.',
    };
  }
  const loc = requestedLocation == null ? null : String(requestedLocation).trim() || null;
  if (isReservedPickupSentinel(loc)) {
    return { ok: false, status: 400, message: 'Invalid delivery address.' };
  }
  return { ok: true, deliver_location: loc };
}
