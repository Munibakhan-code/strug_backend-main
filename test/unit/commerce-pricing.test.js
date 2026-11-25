import { describe, it, expect } from 'vitest';
import {
  totalFromLines,
  SHIPPING_FEES,
  __test,
} from '../../routes/payment-routes.js';

const { detectCartSource } = __test;

// Mirrors the FE checkout formula:
//   subtotal + 8% platform fee + region tax on (subtotal+fee) + shipping + tip
// Canada tax = 0.13, platform fee = 0.08.
describe('totalFromLines', () => {
  it('prices a digital/product cart exactly (subtotal + fee + tax)', () => {
    const lines = [{ qty: 2, price: 10 }, { qty: 1, price: 5 }]; // subtotal 25
    const { amount, enforcement } = totalFromLines({ lines, country: 'Canada', source: 'digital' });
    // 25 + 2 (8%) = 27; tax 0.13*27 = 3.51 → 30.51
    expect(amount).toBe(30.51);
    expect(enforcement).toBe('exact');
  });

  it('adds the shipping fee for the chosen mode', () => {
    const lines = [{ qty: 1, price: 100 }];
    const base = totalFromLines({ lines, country: 'Canada', source: 'product' }).amount;
    const shipped = totalFromLines({ lines, country: 'Canada', source: 'product', shippingMode: 'ship_by_seller' }).amount;
    expect(parseFloat((shipped - base).toFixed(2))).toBe(SHIPPING_FEES.ship_by_seller);
  });

  it('adds a tip but never subtracts (negative/garbage tips are clamped to 0)', () => {
    const lines = [{ qty: 1, price: 50 }];
    const noTip = totalFromLines({ lines, country: 'United States', source: 'product' }).amount;
    expect(totalFromLines({ lines, country: 'United States', source: 'product', tip: 10 }).amount).toBe(parseFloat((noTip + 10).toFixed(2)));
    expect(totalFromLines({ lines, country: 'United States', source: 'product', tip: -10 }).amount).toBe(noTip);
    expect(totalFromLines({ lines, country: 'United States', source: 'product', tip: 'abc' }).amount).toBe(noTip);
  });

  it('applies no tax for tax-free jurisdictions', () => {
    const lines = [{ qty: 1, price: 100 }]; // 100 + 8 fee, no tax in US
    expect(totalFromLines({ lines, country: 'United States', source: 'product' }).amount).toBe(108);
  });

  it('prices food carts exactly (modifiers are now priced server-side by option_id)', () => {
    const lines = [{ qty: 1, price: 20 }];
    expect(totalFromLines({ lines, country: 'Canada', source: 'food' }).enforcement).toBe('exact');
  });

  it('applies a promo to the merchandise base before fee + tax (matches the checkout quote)', () => {
    const lines = [{ qty: 1, price: 100 }];
    const priced = totalFromLines({ lines, country: 'Canada', promoDiscount: 20 });
    // 80 + 6.40 (8%) = 86.40; tax 0.13*86.40 = 11.232 → 97.63
    expect(priced.amount).toBe(97.63);
    expect(priced.subtotal).toBe(80);
    expect(priced.grossSubtotal).toBe(100);
    expect(priced.promoDiscount).toBe(20);
  });

  it('never lets a promo push the charge below zero or add money back', () => {
    const lines = [{ qty: 1, price: 50 }];
    const full = totalFromLines({ lines, country: 'Canada' }).amount;
    expect(totalFromLines({ lines, country: 'Canada', promoDiscount: 500 }).amount).toBe(0);
    expect(totalFromLines({ lines, country: 'Canada', promoDiscount: -25 }).amount).toBe(full);
    expect(totalFromLines({ lines, country: 'Canada', promoDiscount: 'abc' }).amount).toBe(full);
  });

  it('treats missing qty as 1 and a non-numeric price as 0', () => {
    const lines = [{ price: 10 }, { qty: 3 }];
    // subtotal = 10*1 + 0*3 = 10; US no tax → 10 + 0.8 = 10.8
    expect(totalFromLines({ lines, country: 'United States', source: 'digital' }).amount).toBe(10.8);
  });
});

describe('detectCartSource', () => {
  it('honours an explicit, valid hint', () => {
    expect(detectCartSource([{ content_id: 1 }], 'food')).toBe('food');
    expect(detectCartSource([{ food_item_id: 1 }], 'product')).toBe('product');
  });

  it('infers from item shape when no hint is given', () => {
    expect(detectCartSource([{ content_id: 9 }])).toBe('digital');
    expect(detectCartSource([{ variation_id: 3 }])).toBe('product');
    expect(detectCartSource([{ listing_id: 7 }])).toBe('product');
    expect(detectCartSource([{ food_item_id: 4 }])).toBe('food');
  });

  it('returns null when the source cannot be determined', () => {
    expect(detectCartSource([{ qty: 1 }])).toBeNull();
    expect(detectCartSource([{ content_id: 1 }], 'bogus')).toBe('digital'); // bad hint → infer
    expect(detectCartSource([{}])).toBeNull();
  });
});
