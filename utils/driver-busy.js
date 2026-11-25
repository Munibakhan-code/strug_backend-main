import prisma from './prisma-client.js';

/**
 * driver_profile_ids currently occupied by a non-terminal engagement in ANY vertical — an
 * open active_trip (ride), a non-terminal food_order/product_order, or a non-terminal
 * courier_order. One driver identity, one busy state, shared by every dispatch path so a
 * driver can't be offered a ride while mid-delivery, or a delivery while mid-ride, etc.
 *
 * excludeVerticals lets a caller check "busy in verticals other than mine" — e.g. courier
 * intentionally allows a courier to hold multiple courier jobs at once (mirrors delivery's
 * own same-vendor batching), so its own vertical is excluded from that check.
 */
export async function getBusyDriverProfileIds({ excludeVerticals = [] } = {}) {
  const want = (vertical) => !excludeVerticals.includes(vertical);
  const queries = [];

  if (want('ride')) {
    queries.push(
      prisma.active_trip.findMany({
        where: { ended_at: null, driver_id: { not: null } },
        select: { driver_id: true },
      }),
    );
  }
  if (want('food')) {
    queries.push(
      prisma.food_order.findMany({
        where: { driver_id: { not: null }, order_status: { notIn: ['delivered', 'cancelled'] } },
        select: { driver_id: true },
      }),
    );
  }
  if (want('product')) {
    queries.push(
      prisma.product_order.findMany({
        where: { driver_id: { not: null }, status: { notIn: ['fulfilled', 'cancelled'] } },
        select: { driver_id: true },
      }),
    );
  }
  if (want('courier')) {
    queries.push(
      prisma.courier_order.findMany({
        where: {
          courier_service_provider_id: { not: null },
          // status is a nullable free-text column — `notIn` alone would silently exclude a
          // null-status row (SQL's `NULL NOT IN (...)` is neither true nor false), so treat
          // null the same as any other non-terminal status: still busy.
          OR: [{ status: { notIn: ['delivered', 'cancelled'] } }, { status: null }],
        },
        select: { courier_service_provider_id: true },
      }),
    );
  }

  const results = await Promise.all(queries);
  const ids = results.flat().map((row) => row.driver_id ?? row.courier_service_provider_id);
  return new Set(ids);
}
