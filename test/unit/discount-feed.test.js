import { describe, expect, it } from 'vitest';
import {
  browseCategoryForProductType,
  filterDeals,
  isMarkdownWindowActive,
  mapListingToDeal,
  mapPromotionToDeal,
  sourceVerticalForProductType,
} from '../../utils/discount-feed.js';
import { clampDiscountPct, effectivePrice } from '../../utils/discount.js';
import { computePromoDiscount, normalizePromoCode } from '../../utils/promotion.js';

describe('discount feed helpers', () => {
  it('maps product types to browse categories and deep-link verticals', () => {
    expect(browseCategoryForProductType('Decor')).toBe('Shopping');
    expect(browseCategoryForProductType('Food')).toBe('Food');
    expect(sourceVerticalForProductType('SecondHand')).toBe('shop');
    expect(sourceVerticalForProductType('Wedding')).toBe('wedding');
  });

  it('respects markdown windows', () => {
    const now = new Date('2026-07-30T12:00:00Z');
    expect(isMarkdownWindowActive({ discount_pct: 20 }, now)).toBe(true);
    expect(isMarkdownWindowActive({
      discount_pct: 20,
      discount_starts_at: new Date('2026-08-01T00:00:00Z'),
    }, now)).toBe(false);
    expect(isMarkdownWindowActive({
      discount_pct: 20,
      discount_ends_at: new Date('2026-07-01T00:00:00Z'),
    }, now)).toBe(false);
  });

  it('maps listings and promotions into feed deals', () => {
    const deal = mapListingToDeal({
      listing_id: 11,
      name: 'Lamp',
      seller_id: 4,
      product_type_id: 2,
      availability: 3,
      product_type: { product_type_id: 2, product_type_name: 'Decor' },
      product_variation: [{ variation_id: 8, price: 40, discount_pct: 25 }],
    });
    expect(deal).toMatchObject({
      listing_id: 11,
      category: 'Shopping',
      source_vertical: 'decor',
      deep_link: '/listing/decor/11',
      sale_price: 30,
      discount_pct: 25,
    });

    const promo = mapPromotionToDeal({
      promotion_id: 5,
      code: 'SAVE5',
      title: '$5 off',
      kind: 'coupon',
      discount_type: 'fixed',
      discount_value: 5,
      category: 'Shopping',
      status: 'active',
    });
    expect(promo.deal_kind).toBe('coupon');
    expect(promo.promotion_id).toBe(5);
    expect(promo.code).toBeNull();
  });

  it('filters and sorts deals', () => {
    const deals = [
      { listing_id: 1, name: 'A', category: 'Food', discount_pct: 10, deal_kind: 'sale', source_vertical: 'food' },
      { listing_id: 2, name: 'B', category: 'Shopping', discount_pct: 40, deal_kind: 'sale', source_vertical: 'shop', expires_at: '2026-08-01' },
      { promotion_id: 3, name: 'C', category: 'Shopping', discount_pct: 15, deal_kind: 'coupon', code: 'X' },
    ];
    expect(filterDeals(deals, { category: 'Food' })).toHaveLength(1);
    expect(filterDeals(deals, { sort: 'biggest' })[0].listing_id).toBe(2);
    expect(filterDeals(deals, { q: 'x', kind: 'coupon' })).toHaveLength(1);
  });
});

describe('promotion helpers', () => {
  it('normalizes codes and computes discounts', () => {
    expect(normalizePromoCode(' strug10 ')).toBe('STRUG10');
    expect(computePromoDiscount({ discount_type: 'percent', discount_value: 10 }, 80)).toBe(8);
    expect(computePromoDiscount({ discount_type: 'fixed', discount_value: 5 }, 3)).toBe(3);
    expect(clampDiscountPct(120)).toBe(95);
    expect(effectivePrice(100, 20)).toBe(80);
  });
});
