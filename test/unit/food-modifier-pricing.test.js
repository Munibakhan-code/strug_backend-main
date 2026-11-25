import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Prisma singleton so we can exercise the food-modifier pricing branch of
// computeCommerceCartAmount without a database. The food branch reads food_item.price
// (base) and food_item_modifier_option.price (selected options, validated to belong to
// the ordered item and be available).
const foodItemFindMany = vi.fn();
const optionFindMany = vi.fn();
const foodVendorFindUnique = vi.fn();
const getDistanceMatrixMock = vi.fn();
vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    food_item: { findMany: (...a) => foodItemFindMany(...a) },
    food_item_modifier_option: { findMany: (...a) => optionFindMany(...a) },
    food_vendor: { findUnique: (...a) => foodVendorFindUnique(...a) },
  },
}));
vi.mock('../../utils/google-maps.js', () => ({
  getDistanceMatrix: (...a) => getDistanceMatrixMock(...a),
}));

const { computeCommerceCartAmount } = await import('../../routes/payment-routes.js');

// US is tax-free in tax-config, so amount = subtotal + 8% platform fee — keeps the
// arithmetic obvious. food_item 1 = $20 base; option 11 = +$2 (belongs to item 1),
// option 12 = +$5 (belongs to item 1), option 99 = belongs to a DIFFERENT item (2).
beforeEach(() => {
  foodItemFindMany.mockReset();
  optionFindMany.mockReset();
  foodVendorFindUnique.mockReset();
  getDistanceMatrixMock.mockReset();
  foodItemFindMany.mockResolvedValue([{ food_item_id: 1, price: 20, vendor_id: 7, vendor_type_id: 1 }]);
  foodVendorFindUnique.mockResolvedValue({ location: '10 Market St' });
  getDistanceMatrixMock.mockResolvedValue({ distance: { value: 0 } });
});

describe('computeCommerceCartAmount — food modifiers (exact)', () => {
  it('adds selected modifier option prices to the base item price', async () => {
    optionFindMany.mockResolvedValue([
      { option_id: 11, price: 2, group: { food_item_id: 1 } },
      { option_id: 12, price: 5, group: { food_item_id: 1 } },
    ]);
    const res = await computeCommerceCartAmount({
      items: [{ food_item_id: 1, qty: 1, modifier_option_ids: [11, 12] }],
      country: 'United States',
      source: 'food',
    });
    // subtotal = 20 + 2 + 5 = 27; + 8% fee = 29.16; no US tax; zero-distance delivery fee.
    expect(res.ok).toBe(true);
    expect(res.enforcement).toBe('exact');
    expect(res.amount).toBe(29.16);
  });

  it('uses the same server-side food delivery fee resolver as order creation', async () => {
    getDistanceMatrixMock.mockResolvedValue({ distance: { value: 1200 } });
    optionFindMany.mockResolvedValue([]);

    const res = await computeCommerceCartAmount({
      items: [{ food_item_id: 1, qty: 1 }],
      country: 'United States',
      source: 'food',
      deliveryLocation: '20 Queen St',
    });

    // subtotal 20 + platform 1.6 + delivery (1.2km * $2.50) 3 = 24.6.
    expect(res).toMatchObject({ ok: true, enforcement: 'exact', amount: 24.6, shipping: 3 });
    expect(foodVendorFindUnique).toHaveBeenCalledWith({
      where: { vendor_id: 7 },
      select: { location: true },
    });
    expect(getDistanceMatrixMock).toHaveBeenCalledWith('10 Market St', '20 Queen St');
  });

  it('rejects mixed-restaurant food carts instead of charging one delivery fee', async () => {
    foodItemFindMany.mockResolvedValue([
      { food_item_id: 1, price: 20, vendor_id: 7, vendor_type_id: 1 },
      { food_item_id: 2, price: 10, vendor_id: 8, vendor_type_id: 1 },
    ]);
    optionFindMany.mockResolvedValue([]);

    const res = await computeCommerceCartAmount({
      items: [{ food_item_id: 1, qty: 1 }, { food_item_id: 2, qty: 1 }],
      country: 'United States',
      source: 'food',
      deliveryLocation: '20 Queen St',
    });

    expect(res.ok).toBe(false);
    expect(res.fallback).toBe(false);
    expect(res.error).toMatch(/multiple restaurants/i);
  });

  it('prices to base when no modifiers are selected', async () => {
    optionFindMany.mockResolvedValue([]);
    const res = await computeCommerceCartAmount({
      items: [{ food_item_id: 1, qty: 1 }],
      country: 'United States',
      source: 'food',
    });
    // 20 + 8% = 21.6; zero-distance delivery fee.
    expect(res).toMatchObject({ ok: true, enforcement: 'exact', amount: 21.6 });
  });

  it('rejects (not fallback) an unknown/unavailable option id', async () => {
    // The query filters is_available:true, so an unavailable option simply isn't returned.
    optionFindMany.mockResolvedValue([]);
    const res = await computeCommerceCartAmount({
      items: [{ food_item_id: 1, qty: 1, modifier_option_ids: [777] }],
      country: 'United States',
      source: 'food',
    });
    expect(res.ok).toBe(false);
    expect(res.fallback).toBeFalsy();
    expect(res.error).toMatch(/modifier option/i);
  });

  it('rejects malformed modifier ids on the payment path', async () => {
    optionFindMany.mockResolvedValue([]);
    const res = await computeCommerceCartAmount({
      items: [{ food_item_id: 1, qty: 1, modifier_option_ids: ['abc'] }],
      country: 'United States',
      source: 'food',
    });

    expect(res.ok).toBe(false);
    expect(res.fallback).toBeFalsy();
    expect(res.error).toMatch(/modifier option/i);
  });

  it('rejects an option that belongs to a different food item (spoofed id)', async () => {
    optionFindMany.mockResolvedValue([
      { option_id: 99, price: 0, group: { food_item_id: 2 } },
    ]);
    const res = await computeCommerceCartAmount({
      items: [{ food_item_id: 1, qty: 1, modifier_option_ids: [99] }],
      country: 'United States',
      source: 'food',
    });
    expect(res.ok).toBe(false);
    expect(res.fallback).toBeFalsy();
  });

  it('multiplies (base + modifiers) by qty', async () => {
    optionFindMany.mockResolvedValue([
      { option_id: 11, price: 2, group: { food_item_id: 1 } },
    ]);
    const res = await computeCommerceCartAmount({
      items: [{ food_item_id: 1, qty: 3, modifier_option_ids: [11] }],
      country: 'United States',
      source: 'food',
    });
    // (20 + 2) * 3 = 66; + 8% = 71.28
    expect(res.amount).toBe(71.28);
  });

  it('rejects malformed food quantities on the payment path', async () => {
    optionFindMany.mockResolvedValue([]);
    const res = await computeCommerceCartAmount({
      items: [{ food_item_id: 1, qty: 'abc' }],
      country: 'United States',
      source: 'food',
    });

    expect(res.ok).toBe(false);
    expect(res.fallback).toBeFalsy();
    expect(res.error).toMatch(/quantity/i);
  });
});
