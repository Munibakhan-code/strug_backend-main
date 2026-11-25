import prisma from './prisma-client.js';
import { logCronError } from './cron-email.js';
import { dispatchCreatedRide, SCHEDULE_DISPATCH_LEAD_MIN } from '../routes/ride-request-routes.js';
import { notify } from '../services/notify.js';
import {
  RIDE_STATUS_EMAIL_EVENT,
  sendPassengerRideStatusEmail,
} from './ride-status-email.js';
// Single-flight across replicas: without this every replica fires the same tick.
import { scheduleCron } from './cron-lock.js';

/** How far before scheduled_at a reminder fires (default 15 min). */
export const RIDE_SCHEDULE_REMINDER_LEAD_MIN = Number(process.env.RIDE_SCHEDULE_REMINDER_LEAD_MIN ?? 15);

/**
 * Two independent passes over scheduled rides, run every 2 minutes:
 *
 *  1. Dispatch — a ride held as 'scheduled' gets actually offered to nearby drivers once
 *     scheduled_at is within SCHEDULE_DISPATCH_LEAD_MIN (giving a driver time to reach
 *     pickup), mirroring the exact dispatch path immediate "now" bookings use.
 *  2. Reminder — notify the rider (in-app + push + email) as their scheduled pickup
 *     approaches. Idempotent via reminder_sent_at — claimed with an atomic updateMany so two
 *     concurrent ticks can't both send it, the same pattern active_trip.driver_arrived_at uses.
 */
export function startRideScheduleCron(io) {
  scheduleCron('ride-schedule', '*/2 * * * *', async () => {
    await dispatchDueScheduledRides(io).catch((err) => logCronError('ride-schedule-dispatch', err));
    await sendDueScheduleReminders(io).catch((err) => logCronError('ride-schedule-reminder', err));
  });
}

async function dispatchDueScheduledRides(io) {
  const dueBy = new Date(Date.now() + SCHEDULE_DISPATCH_LEAD_MIN * 60 * 1000);
  const due = await prisma.ride_request.findMany({
    where: { status: 'scheduled', scheduled_at: { not: null, lte: dueBy } },
  });

  if (!due.length) return;

  let dispatched = 0;
  for (const ride of due) {
    // Re-fetch and re-check status — a race guard in case the rider cancelled between the
    // query above and this iteration (mirrors utils/ride-dispatch.js's redispatch pattern).
    const fresh = await prisma.ride_request.findUnique({ where: { ride_request_id: ride.ride_request_id } });
    if (!fresh || fresh.status !== 'scheduled') continue;

    const result = await dispatchCreatedRide(io, fresh);
    if (result.ok) dispatched += 1;
  }

  console.log(`[ride-schedule-cron] Dispatched ${dispatched}/${due.length} due scheduled ride(s).`);
}

async function sendDueScheduleReminders(io) {
  const now = new Date();
  const reminderCutoff = new Date(now.getTime() + RIDE_SCHEDULE_REMINDER_LEAD_MIN * 60 * 1000);
  const due = await prisma.ride_request.findMany({
    where: {
      scheduled_at: { not: null, gt: now, lte: reminderCutoff },
      reminder_sent_at: null,
      status: { in: ['scheduled', 'pending', 'accepted'] },
    },
    include: {
      user: { select: { user_id: true, email: true, language: true, name: true } },
    },
  });

  if (!due.length) return;

  let sent = 0;
  for (const ride of due) {
    // Atomic claim — only one concurrent tick can win reminder_sent_at for this ride.
    const claim = await prisma.ride_request.updateMany({
      where: { ride_request_id: ride.ride_request_id, reminder_sent_at: null },
      data: { reminder_sent_at: new Date() },
    });
    if (claim.count !== 1) continue;

    if (ride.passenger_id) {
      notify(io, {
        userId: ride.passenger_id,
        vertical: 'rideshare',
        type: 'ride.schedule_reminder',
        urgency: 'ambient',
        title: 'Your ride is coming up',
        body: `Your scheduled ride is in about ${RIDE_SCHEDULE_REMINDER_LEAD_MIN} minutes. Be ready at your pickup location.`,
        entityType: 'ride_request',
        entityId: ride.ride_request_id,
      }).catch(() => {});
    }

    if (ride.user?.email) {
      await sendPassengerRideStatusEmail(RIDE_STATUS_EMAIL_EVENT.REMINDER, {
        passengerUser: ride.user,
        ride,
      }).catch(() => {});
    }

    // Once a driver has accepted, let them know too — they're the one who needs to actually
    // be there on time.
    if (ride.assigned_driver_id) {
      const driverProfile = await prisma.driver_profile.findUnique({
        where: { driver_profile_id: ride.assigned_driver_id },
        select: { user_id: true },
      });
      if (driverProfile?.user_id) {
        notify(io, {
          userId: driverProfile.user_id,
          vertical: 'rideshare',
          type: 'ride.schedule_reminder',
          urgency: 'ambient',
          title: 'Scheduled pickup coming up',
          body: `Your scheduled pickup is in about ${RIDE_SCHEDULE_REMINDER_LEAD_MIN} minutes.`,
          entityType: 'ride_request',
          entityId: ride.ride_request_id,
        }).catch(() => {});
      }
    }

    sent += 1;
  }

  console.log(`[ride-schedule-cron] Sent ${sent}/${due.length} schedule reminder(s).`);
}
