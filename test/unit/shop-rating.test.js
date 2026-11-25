import { describe, it, expect } from 'vitest';
import { validateProductRatingBody } from '../../utils/shop-rating.js';

describe('validateProductRatingBody', () => {
  it('accepts a valid rating payload', () => {
    const result = validateProductRatingBody({
      seller_id: 42,
      buyer_id: 7,
      order_id: 99,
      rating: 5,
      feedback: 'Great',
      product_type_id: 1,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      seller_id: 42,
      buyer_id: 7,
      order_id: 99,
      rating: 5,
      feedback: 'Great',
    });
  });

  it('rejects out-of-range ratings', () => {
    const result = validateProductRatingBody({
      seller_id: 1,
      buyer_id: 2,
      rating: 6,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('rating'))).toBe(true);
  });
});
