import { describe, it, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  cardTxnLimit,
  splitAmount,
  buildEventPaymentPlan,
  normalizeCountry,
} from '../../utils/event-payment-plan.js';

describe('normalizeCountry', () => {
  it('passes ISO-2 through and folds common long-form names', () => {
    assert.equal(normalizeCountry('ca'), 'CA');
    assert.equal(normalizeCountry('Canada'), 'CA');
    assert.equal(normalizeCountry('United States'), 'US');
    assert.equal(normalizeCountry(''), null);
    assert.equal(normalizeCountry('Freedonia'), null);
  });
});

describe('cardTxnLimit', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  it('returns the market cap for a known country', () => {
    assert.equal(cardTxnLimit('CA'), 1500);
    assert.equal(cardTxnLimit('Canada'), 1500);
  });

  it('falls back to a low default for unknown / missing country', () => {
    assert.equal(cardTxnLimit(null), 1500);
    assert.equal(cardTxnLimit('ZZ'), 1500);
  });

  it('honours an env override per country and for the default', () => {
    process.env.EVENT_CARD_TXN_LIMIT_CA = '2500';
    process.env.EVENT_CARD_TXN_LIMIT_DEFAULT = '999';
    assert.equal(cardTxnLimit('CA'), 2500);
    assert.equal(cardTxnLimit('ZZ'), 999);
  });
});

describe('splitAmount', () => {
  it('keeps an at-or-under-limit amount as a single charge', () => {
    assert.deepEqual(splitAmount(1500, 1500), [1500]);
    assert.deepEqual(splitAmount(420.5, 1500), [420.5]);
  });

  it('splits an over-limit amount into the fewest even installments', () => {
    const parts = splitAmount(4000, 1500);
    assert.equal(parts.length, 3);
    parts.forEach((p) => assert.ok(p <= 1500));
    assert.equal(parts.reduce((a, b) => a + b, 0), 4000);
  });

  it('is cents-exact when the total does not divide evenly', () => {
    const parts = splitAmount(1000.01, 400);
    assert.equal(parts.length, 3);
    assert.equal(Math.round(parts.reduce((a, b) => a + b, 0) * 100), 100001);
    parts.forEach((p) => assert.ok(p <= 400));
  });

  it('returns [] for a non-positive amount', () => {
    assert.deepEqual(splitAmount(0, 1500), []);
    assert.deepEqual(splitAmount(-10, 1500), []);
  });
});

describe('buildEventPaymentPlan', () => {
  const cart = {
    venue: { listing_id: 7, title: 'The Loft', line_total: 4200 },
    catering: { vendor_id: 12, seller_id: 3, title: 'Maple & Thyme', line_total: 1800 },
    floral: { vendor_id: 15, title: 'Fern & Fig', line_total: 900 },
  };

  it('splits a wedding-sized Canadian cart into under-limit card charges', () => {
    const plan = buildEventPaymentPlan({ cart, country: 'CA', currency: 'cad' });
    assert.equal(plan.per_transaction_limit, 1500);
    assert.equal(plan.currency, 'CAD');
    assert.equal(plan.grand_total, 6900);
    assert.ok(plan.requires_split);
    plan.segments.forEach((s) => assert.ok(s.amount <= 1500));
    // venue 4200 -> 3, catering 1800 -> 2, floral 900 -> 1
    assert.equal(plan.segments.length, 6);
    assert.equal(plan.payment_count, 6);
    const venueSegs = plan.segments.filter((s) => s.category === 'venue');
    assert.equal(venueSegs.length, 3);
    assert.equal(venueSegs.reduce((a, b) => a + b.amount, 0), 4200);
    assert.deepEqual(venueSegs.map((s) => s.installment), [1, 2, 3]);
    venueSegs.forEach((s) => assert.equal(s.installments, 3));
  });

  it('carries the line identifiers the checkout needs onto every segment', () => {
    const plan = buildEventPaymentPlan({ cart, country: 'CA' });
    const catering = plan.segments.filter((s) => s.category === 'catering');
    catering.forEach((s) => {
      assert.equal(s.vendor_id, 12);
      assert.equal(s.seller_id, 3);
      assert.equal(s.listing_id, null);
    });
  });

  it('is a single charge per piece when nothing exceeds the limit', () => {
    const plan = buildEventPaymentPlan({
      cart: { venue: { line_total: 1200 }, floral: { line_total: 300 } },
      country: 'CA',
    });
    assert.equal(plan.requires_split, false);
    assert.equal(plan.segments.length, 2);
    assert.equal(plan.payment_count, 2);
  });

  it('skips empty / zero / malformed lines', () => {
    const plan = buildEventPaymentPlan({
      cart: { venue: { line_total: 0 }, catering: null, floral: { line_total: 500 } },
      country: 'US',
    });
    assert.equal(plan.segments.length, 1);
    assert.equal(plan.segments[0].category, 'floral');
    assert.equal(plan.grand_total, 500);
  });

  it('handles a missing cart', () => {
    const plan = buildEventPaymentPlan({ cart: null, country: 'CA' });
    assert.deepEqual(plan.segments, []);
    assert.equal(plan.grand_total, 0);
    assert.equal(plan.requires_split, false);
  });
});
