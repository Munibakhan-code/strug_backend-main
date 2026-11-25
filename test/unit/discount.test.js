import { describe, it, expect } from 'vitest';
import { clampDiscountPct, effectivePrice } from '../../utils/discount.js';

describe('clampDiscountPct', () => {
  it('passes through a valid percent', () => {
    expect(clampDiscountPct(20)).toBe(20);
  });
  it('treats 0, negatives, null, and non-numbers as no sale', () => {
    expect(clampDiscountPct(0)).toBe(0);
    expect(clampDiscountPct(-5)).toBe(0);
    expect(clampDiscountPct(null)).toBe(0);
    expect(clampDiscountPct(undefined)).toBe(0);
    expect(clampDiscountPct('abc')).toBe(0);
  });
  it('caps at 95 and rounds to an integer', () => {
    expect(clampDiscountPct(120)).toBe(95);
    expect(clampDiscountPct(33.6)).toBe(34);
  });
});

describe('effectivePrice', () => {
  it('applies the discount, rounded to cents', () => {
    expect(effectivePrice(100, 20)).toBe(80);
    expect(effectivePrice(19.99, 25)).toBe(14.99);
    expect(effectivePrice(50, 10)).toBe(45);
  });
  it('returns the base price when there is no valid discount', () => {
    expect(effectivePrice(100, 0)).toBe(100);
    expect(effectivePrice(100, null)).toBe(100);
    expect(effectivePrice(100, -3)).toBe(100);
  });
  it('never charges more than the original and respects the 95% cap', () => {
    expect(effectivePrice(100, 999)).toBe(5); // capped at 95% off
  });
  it('passes a non-numeric price through unchanged', () => {
    expect(effectivePrice(null, 20)).toBe(null);
  });
});
