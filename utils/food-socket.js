import prisma from './prisma-client.js';

// Food/grocery/restaurant delivery GPS relay — mirrors courier-socket.js but keyed on
// food_order_id. Customers watch via `food-location-${food_order_id}` on their user room.

const foodLocationLastEmit = new Map();

/** Live kitchen/courier statuses that may broadcast GPS to the buyer. */
export const FOOD_LOCATION_BROADCAST_STATUSES = [
  'ready_for_pickup',
  'picked_up',
  'dispatched',
];

export function shouldEmitFoodOrderLocation(orderId, minIntervalMs = 3000) {
  const key = String(orderId);
  const now = Date.now();
  const last = foodLocationLastEmit.get(key) ?? 0;
  if (now - last < minIntervalMs) return false;
  foodLocationLastEmit.set(key, now);
  return true;
}

export function buildFoodOrderLocationPayload(orderId, lat, lng, status) {
  const latitude = Number(lat);
  const longitude = Number(lng);
  return {
    food_order_id: Number(orderId),
    lat: latitude,
    lng: longitude,
    long: longitude,
    order_status: status ?? null,
    status: status ?? null,
    timestamp: new Date().toISOString(),
  };
}

export function clearFoodOrderLocation(orderId) {
  if (orderId == null) return;
  const id = Number(orderId);
  if (!id || Number.isNaN(id)) return;
  foodLocationLastEmit.delete(String(id));
}

/**
 * Broadcast an assigned food courier's GPS to the customer who owns the order.
 * Only the driver on driver_id may publish; order must be in-flight delivery (not pickup-only).
 */
export async function publishFoodOrderLocation(io, orderId, driverUserId, lat, lng, { minIntervalMs = 3000 } = {}) {
  if (!io || orderId == null || driverUserId == null || lat == null || lng == null) return false;
  const id = Number(orderId);
  const uid = Number(driverUserId);
  if (!id || Number.isNaN(id) || !uid || Number.isNaN(uid)) return false;
  if (Number.isNaN(Number(lat)) || Number.isNaN(Number(lng))) return false;

  if (!shouldEmitFoodOrderLocation(id, minIntervalMs)) return false;

  const order = await prisma.food_order.findFirst({
    where: {
      food_order_id: id,
      driver_id: { not: null },
      order_status: { in: FOOD_LOCATION_BROADCAST_STATUSES },
      fulfillment_mode: { not: 'pickup' },
      driver_profile: { user_id: uid },
    },
    select: {
      food_order_id: true,
      order_status: true,
      user_id: true,
    },
  });
  if (!order?.user_id) return false;

  io.to(`user-${order.user_id}`).emit(
    `food-location-${id}`,
    buildFoodOrderLocationPayload(id, lat, lng, order.order_status),
  );
  return true;
}
