import { describe, it, expect, vi, beforeEach } from 'vitest';

const findFirst = vi.fn();
vi.mock('../../utils/prisma-client.js', () => ({
  default: { food_order: { findFirst: (...a) => findFirst(...a) } },
}));

const {
  publishFoodOrderLocation,
  buildFoodOrderLocationPayload,
  clearFoodOrderLocation,
} = await import('../../utils/food-socket.js');

let nextOrderId = 2000;
const orderId = () => ++nextOrderId;

function mockIo() {
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  return { io: { to }, to, emit };
}

beforeEach(() => findFirst.mockReset());

describe('buildFoodOrderLocationPayload', () => {
  it('includes food_order_id and coordinates', () => {
    const p = buildFoodOrderLocationPayload(12, 31.5, 74.2, 'picked_up');
    expect(p).toMatchObject({ food_order_id: 12, lat: 31.5, lng: 74.2, order_status: 'picked_up' });
  });
});

describe('publishFoodOrderLocation', () => {
  it('relays to the owning customer room', async () => {
    const id = orderId();
    const { io, to, emit } = mockIo();
    findFirst.mockResolvedValue({
      food_order_id: id,
      order_status: 'picked_up',
      user_id: 88,
    });

    const sent = await publishFoodOrderLocation(io, id, 9, 31.5, 74.2);

    expect(sent).toBe(true);
    expect(to).toHaveBeenCalledWith('user-88');
    expect(emit).toHaveBeenCalledWith(
      `food-location-${id}`,
      expect.objectContaining({ food_order_id: id, lat: 31.5, lng: 74.2 }),
    );
  });

  it('requires assigned driver on a live order', async () => {
    const id = orderId();
    const { io } = mockIo();
    findFirst.mockResolvedValue(null);

    await publishFoodOrderLocation(io, id, 9, 31.5, 74.2);

    const where = findFirst.mock.calls[0][0].where;
    expect(where.food_order_id).toBe(id);
    expect(where.driver_profile).toEqual({ user_id: 9 });
    expect(where.order_status).toEqual({ in: ['ready_for_pickup', 'picked_up', 'dispatched'] });
  });

  it('rate-limits repeat pings', async () => {
    const id = orderId();
    const { io, emit } = mockIo();
    findFirst.mockResolvedValue({
      food_order_id: id,
      order_status: 'picked_up',
      user_id: 88,
    });

    expect(await publishFoodOrderLocation(io, id, 9, 31.5, 74.2)).toBe(true);
    expect(await publishFoodOrderLocation(io, id, 9, 31.6, 74.3)).toBe(false);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('clears rate limit for terminal orders', async () => {
    const id = orderId();
    const { io, emit } = mockIo();
    findFirst.mockResolvedValue({
      food_order_id: id,
      order_status: 'picked_up',
      user_id: 88,
    });

    await publishFoodOrderLocation(io, id, 9, 31.5, 74.2);
    clearFoodOrderLocation(id);
    await publishFoodOrderLocation(io, id, 9, 31.6, 74.3);

    expect(emit).toHaveBeenCalledTimes(2);
  });
});
