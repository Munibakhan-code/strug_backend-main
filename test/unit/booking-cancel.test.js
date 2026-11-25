import { describe, it, expect } from 'vitest';
import { canCancelBooking, canTransition } from '../../services/booking-engine.js';

describe('booking cancel transitions (Phase 2 guest trips)', () => {
  it('allows cancel from active stay statuses', () => {
    for (const s of ['requested', 'awaiting_host', 'confirmed', 'in_progress']) {
      expect(canCancelBooking(s)).toBe(true);
      expect(canTransition(s, 'cancelled')).toBe(true);
    }
  });

  it('blocks cancel from terminal statuses', () => {
    for (const s of ['cancelled', 'completed', 'declined']) {
      expect(canCancelBooking(s)).toBe(false);
    }
  });
});
