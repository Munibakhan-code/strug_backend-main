import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    food_order: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    product_order: { findUnique: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    food_vendor: { update: vi.fn() },
    driver_profile: { findMany: vi.fn(), findUnique: vi.fn() },
    vendor_type: { findMany: vi.fn(async () => [{ vendor_type_id: 7, vendor_type: 'Catering' }]) },
  },
}));

vi.mock('../../utils/google-maps.js', () => ({
  geocodeAddress: vi.fn(),
}));

vi.mock('../../services/notify.js', () => ({
  notify: vi.fn(),
}));

vi.mock('../../utils/driver-busy.js', () => ({
  getBusyDriverProfileIds: vi.fn(async () => new Set()),
}));

const {
  foodCourierOfferableStatuses,
  foodDeliveryType,
  dispatchDeliveryOrder,
  redispatchOrphanedDeliveryOrders,
} = await import('../../utils/delivery-dispatch.js');
const prisma = (await import('../../utils/prisma-client.js')).default;

describe('food courier offerable statuses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.vendor_type.findMany.mockResolvedValue([{ vendor_type_id: 7, vendor_type: 'Catering' }]);
  });
  it('includes kitchen statuses after seller accept, not only confirmed', () => {
    expect(foodCourierOfferableStatuses()).toEqual([
      'confirmed',
      'preparing',
      'ready_for_pickup',
    ]);
    expect(foodDeliveryType.offerableStatuses).toEqual(foodCourierOfferableStatuses());
  });

  it('does not dispatch pending or delivered orders', async () => {
    prisma.food_order.findUnique.mockResolvedValue({
      food_order_id: 1,
      order_status: 'pending',
      driver_id: null,
      deliver_location: 'Hasilpur, Punjab, Pakistan',
      food_vendor: { lat: 29.7, long: 72.5, location: 'Hasilpur' },
    });
    await expect(dispatchDeliveryOrder({}, 'food_order', 1)).resolves.toBeNull();

    prisma.food_order.findUnique.mockResolvedValue({
      food_order_id: 1,
      order_status: 'delivered',
      driver_id: null,
      deliver_location: 'Hasilpur, Punjab, Pakistan',
      food_vendor: { lat: 29.7, long: 72.5, location: 'Hasilpur' },
    });
    await expect(dispatchDeliveryOrder({}, 'food_order', 1)).resolves.toBeNull();
  });

  it('does not dispatch self-pickup orders even when kitchen status is offerable', async () => {
    prisma.food_order.findUnique.mockResolvedValue({
      food_order_id: 1,
      order_status: 'confirmed',
      driver_id: null,
      fulfillment_mode: 'pickup',
      deliver_location: '__SELF_PICKUP__',
      food_vendor: { lat: 29.7, long: 72.5, location: 'Hasilpur' },
    });
    await expect(dispatchDeliveryOrder({}, 'food_order', 1)).resolves.toBeNull();
    expect(prisma.driver_profile.findMany).not.toHaveBeenCalled();
  });

  it('does not dispatch when fulfillment_mode is pickup even if a real address was written later', async () => {
    prisma.food_order.findUnique.mockResolvedValue({
      food_order_id: 1,
      order_status: 'preparing',
      driver_id: null,
      fulfillment_mode: 'pickup',
      deliver_location: '123 Main St',
      food_vendor: { lat: 29.7, long: 72.5, location: 'Hasilpur' },
    });
    await expect(dispatchDeliveryOrder({}, 'food_order', 1)).resolves.toBeNull();
    expect(prisma.driver_profile.findMany).not.toHaveBeenCalled();
  });

  it('isDispatchable follows the fulfillment column, not the address field', () => {
    expect(foodDeliveryType.isDispatchable({
      fulfillment_mode: 'pickup',
      deliver_location: '123 Main St',
    })).toBe(false);
    expect(foodDeliveryType.isDispatchable({
      fulfillment_mode: 'delivery',
      deliver_location: '123 Main St',
    })).toBe(true);
    expect(foodDeliveryType.isDispatchable({
      fulfillment_mode: 'delivery',
      deliver_location: '__SELF_PICKUP__',
    })).toBe(false);
  });

  it('orphan sweep filters pickup at the query and orders deterministically', async () => {
    prisma.food_order.findMany.mockResolvedValue([]);
    prisma.product_order.findMany.mockResolvedValue([]);
    await redispatchOrphanedDeliveryOrders({});
    expect(prisma.food_order.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        fulfillment_mode: 'delivery',
        NOT: { deliver_location: '__SELF_PICKUP__' },
        driver_id: null,
        OR: [
          { vendor_type_id: null },
          { vendor_type_id: { notIn: [7] } },
        ],
      }),
      orderBy: { food_order_id: 'asc' },
      take: 20,
    }));
    const foodWhere = prisma.food_order.findMany.mock.calls[0][0].where;
    expect(foodWhere.deliver_location).toBeUndefined();
  });
});
