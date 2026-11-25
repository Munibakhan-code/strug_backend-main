/**
 * Shop store availability + listing stock helpers.
 * Mirrors Food vendor is_active / is_open semantics on store_profile.
 */

/** True when the seller storefront can accept new product orders. */
export function storeAcceptingOrders(storeProfile) {
  if (!storeProfile) return true;
  if (storeProfile.is_active === false) return false;
  if (storeProfile.is_open === false) return false;
  return true;
}

/** Null availability = stock not tracked (always sufficient). */
export function hasSufficientStock(availability, qty) {
  const quantity = Math.max(1, parseInt(qty, 10) || 1);
  if (availability == null) return true;
  return Number(availability) >= quantity;
}

/** Next stock level after a paid order; null when stock is not tracked. */
export function stockAfterOrder(availability, qty) {
  const quantity = Math.max(1, parseInt(qty, 10) || 1);
  if (availability == null) return null;
  return Math.max(0, Number(availability) - quantity);
}
