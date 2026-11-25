import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  mapWeddingVendorToNeed,
  pickNeedForWeddingVendor,
} from '../../utils/wedding-concierge-bridge.js';

describe('mapWeddingVendorToNeed', () => {
  it('maps core wedding vendor types to checklist categories', () => {
    assert.equal(mapWeddingVendorToNeed('Venue').category, 'venue');
    assert.equal(mapWeddingVendorToNeed('Florist').category, 'flowers');
    assert.equal(mapWeddingVendorToNeed('Photography').linked_nav, 'ondemand');
    assert.equal(mapWeddingVendorToNeed('Videography').linked_nav, 'ondemand');
    assert.equal(mapWeddingVendorToNeed('Catering').category, 'catering');
    assert.equal(mapWeddingVendorToNeed('Rental').category, 'rental');
  });

  it('prefers listing title when provided', () => {
    const m = mapWeddingVendorToNeed('Venue', { listingTitle: 'Tuscany Garden Estate' });
    assert.equal(m.title, 'Tuscany Garden Estate');
    assert.equal(m.linked_nav, 'venues');
  });

  it('falls back to wedding nav for unknown types', () => {
    const m = mapWeddingVendorToNeed('Planner');
    assert.equal(m.category, 'planner');
    assert.equal(m.linked_nav, 'wedding');
  });
});

describe('pickNeedForWeddingVendor', () => {
  it('prefers an unlinked non-skipped need in the category', () => {
    const picked = pickNeedForWeddingVendor([
      { event_need_id: 1, category: 'venue', booking_id: 9, status: 'booked' },
      { event_need_id: 2, category: 'venue', booking_id: null, status: 'todo' },
      { event_need_id: 3, category: 'flowers', booking_id: null, status: 'todo' },
    ], 'venue');
    assert.equal(picked.event_need_id, 2);
  });

  it('returns null when category needs are already booked', () => {
    const picked = pickNeedForWeddingVendor([
      { event_need_id: 1, category: 'venue', booking_id: 9, status: 'booked' },
    ], 'venue');
    assert.equal(picked, null);
  });
});
