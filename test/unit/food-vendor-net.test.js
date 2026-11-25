import { describe, it, expect } from 'vitest';
import { vendorNetOf, isFoodSettledStatus, foodFeePct } from '../../utils/food-vendor-net.js';

describe('vendorNetOf', () => {
  it('recovers item subtotal from platform_fee / fee pct', () => {
    const pct = foodFeePct();
    expect(vendorNetOf({ platform_fee: 8, total_amount: 120, delivery_fee: 5, tip_amount: 3 })).toBeCloseTo(8 / pct, 5);
  });

  it('falls back to total minus delivery and tip when platform_fee is missing', () => {
    expect(vendorNetOf({ total_amount: 100, delivery_fee: 10, tip_amount: 5 })).toBe(85);
  });

  it('never returns a negative net', () => {
    expect(vendorNetOf({ total_amount: 5, delivery_fee: 10, tip_amount: 0 })).toBe(0);
  });
});

describe('isFoodSettledStatus', () => {
  it('treats picked_up, delivered, and completed as settled', () => {
    expect(isFoodSettledStatus('picked_up')).toBe(true);
    expect(isFoodSettledStatus('delivered')).toBe(true);
    expect(isFoodSettledStatus('completed')).toBe(true);
    expect(isFoodSettledStatus('preparing')).toBe(false);
  });
});
