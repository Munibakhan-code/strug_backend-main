import { describe, it, expect } from 'vitest';
import { canAccessBuyerCart, canMutateCartItem } from '../../utils/shop-cart-access.js';

describe('product cart access rules', () => {
  it('allows buyer to read only their own cart', () => {
    expect(canAccessBuyerCart(7, 7)).toBe(true);
    expect(canAccessBuyerCart(7, 8)).toBe(false);
  });

  it('allows mutate only when cart belongs to caller', () => {
    expect(canMutateCartItem(7, { buyer_id: 7 })).toBe(true);
    expect(canMutateCartItem(7, { buyer_id: 9 })).toBe(false);
    expect(canMutateCartItem(7, null)).toBe(false);
  });
});
