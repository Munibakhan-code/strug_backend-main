/**
 * Unified entry point for relaying delivery GPS to customers across verticals.
 * Each vertical keeps its own auth/rate-limit implementation; callers use one API.
 */
import { publishCourierLocation, clearCourierLocation } from './courier-socket.js';
import { publishFoodOrderLocation, clearFoodOrderLocation } from './food-socket.js';

/**
 * @param {'food'|'courier'} vertical
 * @param {import('socket.io').Server} io
 * @param {number} orderId — food_order_id or courier_order_id
 * @param {number} driverUserId
 * @param {number} lat
 * @param {number} lng
 */
export async function publishDeliveryLocation(vertical, io, orderId, driverUserId, lat, lng, opts = {}) {
  if (vertical === 'food') {
    return publishFoodOrderLocation(io, orderId, driverUserId, lat, lng, opts);
  }
  if (vertical === 'courier') {
    return publishCourierLocation(io, orderId, driverUserId, lat, lng, opts);
  }
  return false;
}

/** Clear rate-limit state when an order reaches a terminal status. */
export function clearDeliveryLocation(vertical, orderId) {
  if (vertical === 'food') clearFoodOrderLocation(orderId);
  else if (vertical === 'courier') clearCourierLocation(orderId);
}
