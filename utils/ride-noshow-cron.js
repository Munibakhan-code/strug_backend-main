import prisma from './prisma-client.js';
import { logCronError } from './cron-email.js';
import { cancelRideRequest } from './ride-dispatch.js';
import { notify } from '../services/notify.js';
// Single-flight across replicas: without this every replica fires the same tick.
import { scheduleCron } from './cron-lock.js';

/** Minutes a driver must wait at pickup before a rider is considered a no-show (default 5). */
export const RIDE_NO_SHOW_GRACE_MIN = Number(process.env.RIDE_NO_SHOW_GRACE_MIN ?? 5);

/**
 * A driver arrived at pickup (driver_arrived_at set) and the rider never boarded — the trip
 * never "starts" until the rider's OTP is verified (started_at stays null), so this state is
 * unambiguous. After the grace period, auto-cancel with a no-show fee (reason: 'no_show', fee
 * rate resolved in utils/ride-refund.js) via the same cancelRideRequest pipeline every other
 * cancellation uses, then tell the driver they're free to go with no penalty on their side.
 */
export function startRideNoShowCron(io) {
  scheduleCron('ride-noshow-fee', '*/2 * * * *', async () => {
    try {
      const cutoff = new Date(Date.now() - RIDE_NO_SHOW_GRACE_MIN * 60 * 1000);
      const candidates = await prisma.active_trip.findMany({
        where: {
          driver_arrived_at: { not: null, lt: cutoff },
          started_at: null,
          ended_at: null,
        },
        include: {
          ride_request: { select: { ride_request_id: true, passenger_id: true, status: true } },
          driver_profile: { select: { user_id: true } },
        },
      });

      if (!candidates.length) return;

      let cancelled = 0;
      for (const trip of candidates) {
        const ride = trip.ride_request;
        // Re-check status — the rider may have boarded or the trip may have been resolved by
        // another path (e.g. manual cancel) between the query above and this loop iteration.
        if (!ride || (ride.status || '').toLowerCase() !== 'accepted') continue;

        await cancelRideRequest(io, ride.ride_request_id, ride.passenger_id, 'no_show');
        cancelled += 1;

        const driverUserId = trip.driver_profile?.user_id;
        if (driverUserId) {
          notify(io, {
            userId: driverUserId,
            vertical: 'rideshare',
            type: 'ride.no_show',
            urgency: 'ambient',
            title: 'Rider no-show',
            body: "The rider didn't board in time — you're free to go, no penalty on your side.",
            entityType: 'ride_request',
            entityId: ride.ride_request_id,
          }).catch(() => {});
        }
      }

      console.log(`[ride-noshow-cron] Cancelled ${cancelled}/${candidates.length} no-show trip(s).`);
    } catch (err) {
      logCronError('ride-noshow-cron', err);
    }
  });
}
