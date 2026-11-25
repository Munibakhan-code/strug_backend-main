import { beforeEach, describe, expect, it, vi } from 'vitest';

const notify = vi.fn(() => Promise.resolve(null));
vi.mock('../../services/notify.js', () => ({ notify, default: notify }));

const { notifyRider } = await import('../../utils/ride-rider-notify.js');

const io = { to: vi.fn(() => ({ emit: vi.fn() })) };

beforeEach(() => notify.mockClear());

describe('notifyRider', () => {
  it('routes every rider event through notify() on the rideshare vertical, ambient, deep-linked to the ride', () => {
    for (const event of ['accepted', 'driver_arrived', 'started', 'completed', 'cancelled']) {
      notify.mockClear();
      notifyRider(io, event, { passengerId: 42, rideRequestId: 7, tripId: 99, body: 'x' });
      expect(notify).toHaveBeenCalledTimes(1);
      const arg = notify.mock.calls[0][1];
      expect(arg).toMatchObject({
        userId: 42,
        vertical: 'rideshare',
        urgency: 'ambient',            // must NOT be actionable — the rider has no inline accept/decline
        entityType: 'ride_request',
        entityId: 7,
        actionUrl: 'rideshare',
      });
      expect(arg.type).toBe(`ride.${event === 'driver_arrived' ? 'driver_arrived' : event}`);
      expect(arg.data.trip_id).toBe(99);
    }
  });

  it('is a no-op for an unknown event or a missing/invalid passenger id', () => {
    notifyRider(io, 'bogus', { passengerId: 42, rideRequestId: 7 });
    notifyRider(io, 'accepted', { passengerId: 0, rideRequestId: 7 });
    notifyRider(io, 'accepted', { passengerId: null, rideRequestId: 7 });
    expect(notify).not.toHaveBeenCalled();
  });

  it('lets a caller override the title (cancellations vary by reason) and merges extra data', () => {
    notifyRider(io, 'cancelled', {
      passengerId: 5,
      rideRequestId: 3,
      title: "We couldn't find a driver",
      data: { reason: 'no_driver_found', refunded: true },
    });
    const arg = notify.mock.calls[0][1];
    expect(arg.title).toBe("We couldn't find a driver");
    expect(arg.data).toMatchObject({ reason: 'no_driver_found', refunded: true });
  });

  it('passes the driver user id as actorUserId so a platform-blocked pair is suppressed by notify()', () => {
    notifyRider(io, 'accepted', { passengerId: 5, rideRequestId: 3, actorUserId: 88 });
    expect(notify.mock.calls[0][1].actorUserId).toBe(88);
  });
});
