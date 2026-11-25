import { describe, it, expect } from 'vitest';
import {
  FOOD_SELF_PICKUP_SENTINEL,
  assertFulfillmentLocked,
  foodCourierDispatchWhere,
  isFoodPickupOrder,
  isReservedPickupSentinel,
  persistDeliverLocation,
  publicDeliverLocation,
  sanitizeDeliverLocationUpdate,
} from '../../utils/food-fulfillment.js';

describe('isFoodPickupOrder', () => {
  it('trusts fulfillment_mode over a later real address (free-delivery lock)', () => {
    expect(isFoodPickupOrder({
      fulfillment_mode: 'pickup',
      deliver_location: '123 Main St',
      delivery_fee: 0,
    })).toBe(true);
  });

  it('treats fulfillment_mode delivery as courier even with zero fee', () => {
    expect(isFoodPickupOrder({
      fulfillment_mode: 'delivery',
      deliver_location: '123 Main St',
      delivery_fee: 0,
      driver_id: null,
    })).toBe(false);
  });

  it('falls back to the sentinel when the column is missing', () => {
    expect(isFoodPickupOrder({ deliver_location: FOOD_SELF_PICKUP_SENTINEL })).toBe(true);
  });
});

describe('persistDeliverLocation', () => {
  it('writes the sentinel for pickup and never for delivery', () => {
    expect(persistDeliverLocation('pickup', 'ignored')).toBe(FOOD_SELF_PICKUP_SENTINEL);
    expect(persistDeliverLocation('delivery', '20 Queen St')).toBe('20 Queen St');
    expect(persistDeliverLocation('delivery', FOOD_SELF_PICKUP_SENTINEL)).toBeNull();
  });
});

describe('publicDeliverLocation', () => {
  it('hides the sentinel from customers and drivers', () => {
    expect(publicDeliverLocation({ deliver_location: FOOD_SELF_PICKUP_SENTINEL })).toBeNull();
    expect(publicDeliverLocation({ deliver_location: '20 Queen St' })).toBe('20 Queen St');
  });
});

describe('foodCourierDispatchWhere', () => {
  it('uses Prisma NOT so legacy null-address delivery rows stay in the pool', () => {
    expect(foodCourierDispatchWhere()).toEqual({
      fulfillment_mode: 'delivery',
      NOT: { deliver_location: FOOD_SELF_PICKUP_SENTINEL },
    });
    expect(foodCourierDispatchWhere().deliver_location).toBeUndefined();
  });

  it('excludes catering type ids without dropping NULL vendor_type_id rows', () => {
    expect(foodCourierDispatchWhere({ cateringTypeIds: [7, 12] })).toEqual({
      fulfillment_mode: 'delivery',
      NOT: { deliver_location: FOOD_SELF_PICKUP_SENTINEL },
      OR: [
        { vendor_type_id: null },
        { vendor_type_id: { notIn: [7, 12] } },
      ],
    });
  });
});

describe('create-time lock', () => {
  const pickup = { fulfillment_mode: 'pickup', deliver_location: FOOD_SELF_PICKUP_SENTINEL };

  it('rejects flipping fulfillment_mode after create', () => {
    const locked = assertFulfillmentLocked(pickup, 'delivery');
    expect(locked.ok).toBe(false);
    expect(locked.status).toBe(403);
  });

  it('rejects writing a real address onto a pickup order', () => {
    const loc = sanitizeDeliverLocationUpdate(pickup, '123 Main St');
    expect(loc.ok).toBe(false);
    expect(loc.status).toBe(403);
  });

  it('rejects writing the sentinel onto a delivery order', () => {
    const loc = sanitizeDeliverLocationUpdate(
      { fulfillment_mode: 'delivery', deliver_location: '20 Queen St' },
      FOOD_SELF_PICKUP_SENTINEL,
    );
    expect(loc.ok).toBe(false);
    expect(loc.status).toBe(400);
  });

  it('allows a real address update on a delivery order', () => {
    const loc = sanitizeDeliverLocationUpdate(
      { fulfillment_mode: 'delivery', deliver_location: '20 Queen St' },
      '30 King St',
    );
    expect(loc).toEqual({ ok: true, deliver_location: '30 King St' });
  });

  it('recognizes the reserved sentinel', () => {
    expect(isReservedPickupSentinel(FOOD_SELF_PICKUP_SENTINEL)).toBe(true);
    expect(isReservedPickupSentinel('  __SELF_PICKUP__  ')).toBe(true);
    expect(isReservedPickupSentinel('20 Queen St')).toBe(false);
  });
});
