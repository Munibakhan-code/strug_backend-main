import { describe, it, expect } from 'vitest';
import {
  storeAcceptingOrders,
  hasSufficientStock,
  stockAfterOrder,
} from '../../utils/shop-availability.js';

describe('storeAcceptingOrders', () => {
  it('allows orders when profile is missing (legacy sellers)', () => {
    expect(storeAcceptingOrders(null)).toBe(true);
    expect(storeAcceptingOrders(undefined)).toBe(true);
  });

  it('blocks deactivated stores', () => {
    expect(storeAcceptingOrders({ is_active: false, is_open: true })).toBe(false);
  });

  it('blocks temporarily closed stores', () => {
    expect(storeAcceptingOrders({ is_active: true, is_open: false })).toBe(false);
  });

  it('allows active open stores', () => {
    expect(storeAcceptingOrders({ is_active: true, is_open: true })).toBe(true);
  });
});

describe('hasSufficientStock', () => {
  it('treats null availability as untracked stock', () => {
    expect(hasSufficientStock(null, 99)).toBe(true);
    expect(hasSufficientStock(undefined, 1)).toBe(true);
  });

  it('requires enough units when stock is tracked', () => {
    expect(hasSufficientStock(5, 2)).toBe(true);
    expect(hasSufficientStock(2, 2)).toBe(true);
    expect(hasSufficientStock(1, 2)).toBe(false);
    expect(hasSufficientStock(0, 1)).toBe(false);
  });
});

describe('stockAfterOrder', () => {
  it('returns null when stock is untracked', () => {
    expect(stockAfterOrder(null, 3)).toBeNull();
  });

  it('never goes below zero', () => {
    expect(stockAfterOrder(2, 5)).toBe(0);
    expect(stockAfterOrder(5, 2)).toBe(3);
  });
});
