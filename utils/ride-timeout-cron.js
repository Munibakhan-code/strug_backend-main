import prisma from './prisma-client.js';
import { logCronError } from './cron-email.js';
import { cancelRideRequest } from './ride-dispatch.js';
// Single-flight across replicas: without this every replica fires the same tick.
import { scheduleCron } from './cron-lock.js';

/**
 * Legacy safety net: cancel stale pending rides with no active trip.
 * Refunds are handled inside cancelRideRequest (wallet + card).
 * Prefer processExpiredOffers (5s) for offer-timeout redispatch; this catches orphans.
 */
export function startRideTimeoutCron(io) {
  scheduleCron('ride-timeout-refund', '*/2 * * * *', async () => {
    try {
      const cutoff = new Date(Date.now() - 3 * 60 * 1000);
      const stale = await prisma.ride_request.findMany({
        where: {
          status: 'pending',
          created_at: { lt: cutoff },
          active_trip: { none: {} },
        },
        select: { ride_request_id: true, passenger_id: true },
      });

      if (!stale.length) return;

      for (const r of stale) {
        await cancelRideRequest(io, r.ride_request_id, r.passenger_id, 'no_driver_found');
      }

      console.log(`[ride-timeout-cron] Cancelled ${stale.length} stale ride request(s).`);
    } catch (err) {
      logCronError('ride-timeout-cron', err);
    }
  });
}
