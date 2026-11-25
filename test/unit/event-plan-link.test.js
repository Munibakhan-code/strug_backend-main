import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  normalizeShareCategory,
  pickNeedForCategory,
  resolveTimelineStatus,
} from '../../utils/event-plan-link.js';

describe('normalizeShareCategory', () => {
  it('folds aliases to the canonical Shared Event category', () => {
    assert.equal(normalizeShareCategory('flowers'), 'floral');
    assert.equal(normalizeShareCategory('venues'), 'venue');
    assert.equal(normalizeShareCategory('CATERING'), 'catering');
    assert.equal(normalizeShareCategory('venue'), 'venue');
  });
});

describe('pickNeedForCategory', () => {
  const needs = [
    { event_need_id: 1, category: 'venue', linked_nav: 'venues' },
    { event_need_id: 2, category: 'catering', linked_nav: 'catering' },
    // concierge "dinner" preset seeds the floral need as category "flowers"
    { event_need_id: 3, category: 'flowers', linked_nav: 'floral' },
  ];

  it('matches the seeded need by category or alias', () => {
    assert.equal(pickNeedForCategory(needs, 'venue').event_need_id, 1);
    assert.equal(pickNeedForCategory(needs, 'catering').event_need_id, 2);
    assert.equal(pickNeedForCategory(needs, 'floral').event_need_id, 3);
    assert.equal(pickNeedForCategory(needs, 'flowers').event_need_id, 3);
  });

  it('falls back to linked_nav when the category label differs', () => {
    const byNav = [{ event_need_id: 9, category: 'custom', linked_nav: 'catering' }];
    assert.equal(pickNeedForCategory(byNav, 'catering').event_need_id, 9);
  });

  it('returns null when there is no matching need', () => {
    assert.equal(pickNeedForCategory([{ category: 'decor' }], 'floral'), null);
  });
});

describe('resolveTimelineStatus', () => {
  it('booking: confirmed + paid → booked', () => {
    const s = resolveTimelineStatus({
      kind: 'booking',
      booking: { status: 'confirmed', payment_status: 'paid', total: 500 },
    });
    assert.equal(s, 'booked');
  });

  it('booking: awaiting host → pending', () => {
    const s = resolveTimelineStatus({
      kind: 'booking',
      booking: { status: 'awaiting_host', payment_status: 'paid', total: 500, payment_intent_id: 'pi_1' },
    });
    assert.equal(s, 'pending');
  });

  it('booking: needs payment, none taken → unpaid', () => {
    const s = resolveTimelineStatus({
      kind: 'booking',
      booking: { status: 'requested', payment_status: 'unpaid', total: 500 },
    });
    assert.equal(s, 'unpaid');
  });

  it('booking: cancelled/declined → cancelled', () => {
    assert.equal(resolveTimelineStatus({ kind: 'booking', booking: { status: 'cancelled', total: 0 } }), 'cancelled');
    assert.equal(resolveTimelineStatus({ kind: 'booking', booking: { status: 'declined', total: 0 } }), 'cancelled');
  });

  it('food_order: paid + accepted → booked', () => {
    const s = resolveTimelineStatus({
      kind: 'food_order',
      foodOrder: { order_status: 'accepted', ispaid: true, total_amount: 300 },
    });
    assert.equal(s, 'booked');
  });

  it('food_order: pending → pending', () => {
    const s = resolveTimelineStatus({
      kind: 'food_order',
      foodOrder: { order_status: 'pending', ispaid: true, total_amount: 300, payment_intent_id: 'pi_2' },
    });
    assert.equal(s, 'pending');
  });

  it('food_order: unpaid, no intent → unpaid', () => {
    const s = resolveTimelineStatus({
      kind: 'food_order',
      foodOrder: { order_status: 'pending', ispaid: false, total_amount: 300 },
    });
    assert.equal(s, 'unpaid');
  });

  it('food_order: cancelled/rejected → cancelled', () => {
    assert.equal(resolveTimelineStatus({ kind: 'food_order', foodOrder: { order_status: 'cancelled', total_amount: 0 } }), 'cancelled');
    assert.equal(resolveTimelineStatus({ kind: 'food_order', foodOrder: { order_status: 'rejected', total_amount: 0 } }), 'cancelled');
  });

  it('no linked order → unlinked', () => {
    assert.equal(resolveTimelineStatus({ kind: 'booking', booking: null }), 'unlinked');
    assert.equal(resolveTimelineStatus({ kind: null }), 'unlinked');
  });
});
