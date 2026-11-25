import { describe, it, expect, vi, beforeEach } from 'vitest';

const findFirst = vi.fn();
vi.mock('../../utils/prisma-client.js', () => ({
  default: { courier_order: { findFirst: (...a) => findFirst(...a) } },
}));

const { publishCourierLocation, buildCourierLocationPayload, clearCourierLocation } = await import(
  '../../utils/courier-socket.js'
);

// Each test uses a distinct order id: the rate limiter is module-level state keyed by order, so
// reusing an id across tests would let one test's emit suppress the next one's.
let nextOrderId = 1000;
const orderId = () => ++nextOrderId;

function mockIo() {
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  return { io: { to }, to, emit };
}

beforeEach(() => findFirst.mockReset());

describe('buildCourierLocationPayload', () => {
  it('carries the leg (status) alongside the coordinates', () => {
    const p = buildCourierLocationPayload(7, 43.6532, -79.3832, 'picked_up');
    expect(p).toMatchObject({ courier_order_id: 7, lat: 43.6532, lng: -79.3832, status: 'picked_up' });
    // `long` is duplicated for parity with the rideshare payload shape.
    expect(p.long).toBe(-79.3832);
  });
});

describe('publishCourierLocation', () => {
  it('relays the ping to the owning customer room only', async () => {
    const id = orderId();
    const { io, to, emit } = mockIo();
    findFirst.mockResolvedValue({
      courier_order_id: id,
      status: 'accepted',
      courier_customer: { user_id: 55 },
    });

    const sent = await publishCourierLocation(io, id, 9, 43.6, -79.3);

    expect(sent).toBe(true);
    expect(to).toHaveBeenCalledWith('user-55');
    expect(to).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      `courier-location-${id}`,
      expect.objectContaining({ courier_order_id: id, lat: 43.6, lng: -79.3, status: 'accepted' }),
    );
  });

  it('scopes the lookup to the calling courier and a live order', async () => {
    const id = orderId();
    const { io } = mockIo();
    findFirst.mockResolvedValue(null);

    await publishCourierLocation(io, id, 9, 43.6, -79.3);

    const where = findFirst.mock.calls[0][0].where;
    expect(where.courier_order_id).toBe(id);
    // The courier must be the ASSIGNED provider — this is what stops a courier pushing a fake
    // position into someone else's delivery.
    expect(where.driver_profile).toEqual({ user_id: 9 });
    // ...and the order must still be in flight. A delivered order stops broadcasting.
    expect(where.status).toEqual({ in: ['accepted', 'picked_up'] });
  });

  it('emits nothing when the caller is not the assigned courier', async () => {
    const id = orderId();
    const { io, to } = mockIo();
    findFirst.mockResolvedValue(null); // the where-clause found no such order for this courier

    const sent = await publishCourierLocation(io, id, 1234, 43.6, -79.3);

    expect(sent).toBe(false);
    expect(to).not.toHaveBeenCalled();
  });

  it('emits nothing when the order has no resolvable customer', async () => {
    const id = orderId();
    const { io, to } = mockIo();
    findFirst.mockResolvedValue({ courier_order_id: id, status: 'accepted', courier_customer: null });

    const sent = await publishCourierLocation(io, id, 9, 43.6, -79.3);

    expect(sent).toBe(false);
    expect(to).not.toHaveBeenCalled();
  });

  it('rate-limits repeat pings for the same order without hitting the DB', async () => {
    const id = orderId();
    const { io, emit } = mockIo();
    findFirst.mockResolvedValue({
      courier_order_id: id,
      status: 'accepted',
      courier_customer: { user_id: 55 },
    });

    expect(await publishCourierLocation(io, id, 9, 43.6, -79.3)).toBe(true);
    expect(await publishCourierLocation(io, id, 9, 43.7, -79.4)).toBe(false);

    expect(emit).toHaveBeenCalledTimes(1);
    // Couriers ping every ~5s; the throttle must short-circuit BEFORE the query, not after.
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('lets the next ping through once the order is cleared (delivered)', async () => {
    const id = orderId();
    const { io, emit } = mockIo();
    findFirst.mockResolvedValue({
      courier_order_id: id,
      status: 'accepted',
      courier_customer: { user_id: 55 },
    });

    await publishCourierLocation(io, id, 9, 43.6, -79.3);
    clearCourierLocation(id);
    await publishCourierLocation(io, id, 9, 43.7, -79.4);

    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('no-ops on missing io / order / courier / coordinates', async () => {
    const { io, to } = mockIo();
    expect(await publishCourierLocation(null, 1, 9, 43.6, -79.3)).toBe(false);
    expect(await publishCourierLocation(io, null, 9, 43.6, -79.3)).toBe(false);
    expect(await publishCourierLocation(io, 1, null, 43.6, -79.3)).toBe(false);
    expect(await publishCourierLocation(io, 1, 9, null, -79.3)).toBe(false);
    expect(await publishCourierLocation(io, 1, 9, 'abc', -79.3)).toBe(false);
    expect(to).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
  });
});
