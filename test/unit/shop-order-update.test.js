import { describe, it, expect } from 'vitest';
import { buildProductOrderUpdateData, repricingFields } from '../../utils/shop-order-update.js';

// A settled order: 2 units of variation 1, priced server-side at 50.
const existing = () => ({
    variation_id: 1,
    total: 50,
    qty: 2,
    payment_method: 'card',
    product_type_id: 1,
    checkout_id: null,
    ispaid: true,
});

describe('repricingFields', () => {
    // The underpayment this guard exists for: pay for 2, then PUT {qty: 100} and the order holds
    // 100 units while `total` stays at the 2-unit price. Refusing `total` from the client is not
    // enough — qty is what DETERMINES total.
    it('flags a qty change (buy few, then inflate the order)', () => {
        expect(repricingFields(existing(), { qty: 100 })).toEqual(['qty']);
    });

    // Same hole via the other input to the price: swap in a dearer variant, total stays put.
    it('flags a variation swap (cheap variant paid, dear variant delivered)', () => {
        expect(repricingFields(existing(), { variation_id: 99 })).toEqual(['variation_id']);
    });

    it('flags every price-determining field at once', () => {
        expect(repricingFields(existing(), { variation_id: 9, qty: 7, product_type_id: 3 }))
            .toEqual(['variation_id', 'qty', 'product_type_id']);
    });

    // Clients PUT the whole order object back. Echoing the CURRENT values is not an attempt to
    // re-price, and must not 400 — otherwise the guard breaks every honest update.
    it('allows echoing current values unchanged', () => {
        expect(repricingFields(existing(), { variation_id: 1, qty: 2, product_type_id: 1 })).toEqual([]);
    });

    it('treats a string qty as its numeric value (no type-punning past the guard)', () => {
        expect(repricingFields(existing(), { qty: '2' })).toEqual([]);   // same value, different type
        expect(repricingFields(existing(), { qty: '100' })).toEqual(['qty']);
    });

    it('ignores absent fields', () => {
        expect(repricingFields(existing(), { payment_method: 'wallet' })).toEqual([]);
    });
});

describe('buildProductOrderUpdateData', () => {
    it('never writes total, qty, or variation_id — no matter what the client sends', () => {
        const data = buildProductOrderUpdateData(existing(), {
            total: 1,
            qty: 100,
            variation_id: 99,
            product_type_id: 3,
            payment_method: 'wallet',
        });
        expect(data.total).toBeUndefined();
        expect(data.qty).toBeUndefined();
        expect(data.variation_id).toBeUndefined();
        expect(data.product_type_id).toBeUndefined();
    });

    it('still applies the non-financial fields', () => {
        const data = buildProductOrderUpdateData(existing(), { payment_method: 'wallet', checkout_id: 7 });
        expect(data.payment_method).toBe('wallet');
        expect(data.checkout_id).toBe(7);
    });

    it('falls back to the existing values when nothing is sent', () => {
        const data = buildProductOrderUpdateData(existing(), {});
        expect(data.payment_method).toBe('card');
        expect(data.checkout_id).toBeNull();
    });
});
