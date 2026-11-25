import prisma from './prisma-client.js';

// The courier lane's equivalent of trip-socket.js. Rideshare publishes a driver's GPS into a
// `trip_<id>` room; courier had no such path at all — `driver-location` only persisted the ping
// to driver_profile, so a customer watching a delivery could never see the courier move.
// Couriers have no trip row, so we address the customer directly on their `user-<id>` room,
// which is the same room the courier lifecycle events (courier-accepted-<id>, ...) already use.

const courierLocationLastEmit = new Map();

/** Rate-limit courier location broadcasts (default 3s per order). */
export function shouldEmitCourierLocation(orderId, minIntervalMs = 3000) {
  const key = String(orderId);
  const now = Date.now();
  const last = courierLocationLastEmit.get(key) ?? 0;
  if (now - last < minIntervalMs) return false;
  courierLocationLastEmit.set(key, now);
  return true;
}

export function buildCourierLocationPayload(orderId, lat, lng, status) {
  const latitude = Number(lat);
  const longitude = Number(lng);
  return {
    courier_order_id: Number(orderId),
    lat: latitude,
    lng: longitude,
    long: longitude,
    // The customer draws the route to the pickup before collection and to the drop-off after,
    // so the leg has to ride along with the ping — otherwise the map keeps pointing at a
    // pickup the courier already left.
    status: status ?? null,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Release an order's rate-limit slot once it is terminal (delivered / cancelled). Without this the
 * Map grows for the life of the process. No event is emitted — the customer already stops tracking
 * on `courier-delivered-<id>` / `courier-cancelled-<id>`.
 */
export function clearCourierLocation(orderId) {
  if (orderId == null) return;
  const id = Number(orderId);
  if (!id || Number.isNaN(id)) return;
  courierLocationLastEmit.delete(String(id));
}

/**
 * Broadcast a courier's GPS to the customer who owns the order.
 *
 * Only the courier actually assigned to a live (accepted | picked_up) order may publish, and the
 * ping goes to exactly one room — the owning customer's. A courier cannot use this to probe or
 * push into an order that is not theirs: the where-clause joins provider -> order -> customer, so
 * a mismatched courier_order_id simply finds nothing and we return false without emitting.
 */
export async function publishCourierLocation(io, orderId, courierUserId, lat, lng, { minIntervalMs = 3000 } = {}) {
  if (!io || orderId == null || courierUserId == null || lat == null || lng == null) return false;
  const id = Number(orderId);
  const uid = Number(courierUserId);
  if (!id || Number.isNaN(id) || !uid || Number.isNaN(uid)) return false;
  if (Number.isNaN(Number(lat)) || Number.isNaN(Number(lng))) return false;

  // Rate-limit BEFORE the DB round-trip — couriers ping every ~5s and this runs per ping.
  if (!shouldEmitCourierLocation(id, minIntervalMs)) return false;

  const order = await prisma.courier_order.findFirst({
    where: {
      courier_order_id: id,
      status: { in: ['accepted', 'picked_up'] },
      // Nullable to-one: an unassigned order has a NULL provider and is silently excluded here,
      // which is exactly right — there is no courier to publish for until someone claims it.
      driver_profile: { user_id: uid },
    },
    select: {
      courier_order_id: true,
      status: true,
      courier_customer: { select: { user_id: true } },
    },
  });
  if (!order) return false;

  const customerUid = order.courier_customer?.user_id;
  if (!customerUid) return false;

  io.to(`user-${customerUid}`).emit(
    `courier-location-${id}`,
    buildCourierLocationPayload(id, lat, lng, order.status),
  );
  return true;
}
