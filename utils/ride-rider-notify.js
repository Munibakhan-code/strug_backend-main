// utils/ride-rider-notify.js — rider-facing ride lifecycle notifications.
//
// The driver side of dispatch already routes through services/notify.js (the ride *offer* in
// utils/ride-dispatch.js), so a driver's phone buzzes and the offer lands in the global bell.
// The RIDER side never did: accept / arrived / started / completed / cancelled were only ever
// per-request socket emits (`ride-accepted-<id>`, `driver-arrived-<id>`, …) that the live
// tracking screen listens for. Close that tab and the rider is blind — nothing in the bell, no
// web push when the driver pulls up outside.
//
// This wraps notify() with consistent copy for those five events. It is additive: the legacy
// emits stay (the tracking screen still needs them for its live UI), this just also creates the
// durable row + fires the unified `notification:new` (→ toast + bell) + web push.
//
// Fire-and-forget by contract, exactly like every other notify() caller: never await, never
// let a notification failure touch the ride.

import { notify } from '../services/notify.js';

const RIDER_COPY = {
  accepted:       { type: 'ride.accepted',       title: 'Your driver is on the way' },
  driver_arrived: { type: 'ride.driver_arrived', title: 'Your driver has arrived' },
  started:        { type: 'ride.started',        title: 'Your trip has started' },
  completed:      { type: 'ride.completed',      title: 'Your ride is complete' },
  cancelled:      { type: 'ride.cancelled',      title: 'Your ride was cancelled' },
};

/**
 * @param {import('socket.io').Server} io
 * @param {'accepted'|'driver_arrived'|'started'|'completed'|'cancelled'} event
 * @param {object} opts
 * @param {number} opts.passengerId          recipient (required)
 * @param {string|null} [opts.body]          one-line detail (driver + vehicle, fare, cancel reason)
 * @param {number|null} [opts.rideRequestId] entity id — the ride the row deep-links to
 * @param {number|null} [opts.tripId]        carried in data for the SPA's tracking view
 * @param {number|null} [opts.actorUserId]   the driver's user_id, so a platform-blocked pair is suppressed
 * @param {object|null} [opts.data]          merged into the notification data payload
 * @param {string|null} [opts.title]         override the default title (cancellations vary by reason)
 */
export function notifyRider(io, event, {
  passengerId, body = null, rideRequestId = null, tripId = null,
  actorUserId = null, data = null, title = null,
} = {}) {
  const copy = RIDER_COPY[event];
  const pid = Number(passengerId);
  if (!copy || !Number.isInteger(pid) || pid <= 0) return;

  notify(io, {
    userId: pid,
    actorUserId: actorUserId != null ? Number(actorUserId) : null,
    vertical: 'rideshare',
    type: copy.type,
    // ambient, not actionable: there is no inline accept/decline for the rider, so this must NOT
    // reach the claim card (which keys accept/decline on entity_id — see utils/claimableOffer.js).
    urgency: 'ambient',
    title: title || copy.title,
    body,
    entityType: 'ride_request',
    entityId: rideRequestId != null ? Number(rideRequestId) : null,
    actionUrl: 'rideshare',
    data: {
      ...(tripId != null ? { trip_id: Number(tripId) } : {}),
      ...(data || {}),
    },
  });
}

export default notifyRider;
