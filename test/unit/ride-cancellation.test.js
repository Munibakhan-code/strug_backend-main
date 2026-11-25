import { describe, it, expect } from 'vitest';
import {
  isSystemNoDriverReason,
  buildRideCancellationBaseMessage,
  buildRideCancellationMessage,
} from '../../utils/ride-cancellation.js';

describe('isSystemNoDriverReason', () => {
  it('recognises dispatch exhaustion reasons', () => {
    expect(isSystemNoDriverReason('no_driver_available')).toBe(true);
    expect(isSystemNoDriverReason('no_driver_found')).toBe(true);
    expect(isSystemNoDriverReason('all_drivers_declined')).toBe(true);
  });

  it('does not treat passenger cancel as no-driver', () => {
    expect(isSystemNoDriverReason('cancelled_by_passenger')).toBe(false);
    expect(isSystemNoDriverReason('replaced_by_new_booking')).toBe(false);
    expect(isSystemNoDriverReason(null)).toBe(false);
  });
});

describe('buildRideCancellationMessage', () => {
  it('includes refund reassurance for system no-driver without refund record', () => {
    const msg = buildRideCancellationMessage('no_driver_found', null);
    expect(msg).toContain('No drivers were available');
    expect(msg).toContain('refunded to your wallet or card');
  });

  it('includes refund amount when refunded', () => {
    const msg = buildRideCancellationMessage('no_driver_found', {
      refunded: true,
      amount: 24.76,
      cancel_fee: 0,
      paid_amount: 24.76,
    });
    expect(msg).toContain('$24.76 refunded');
  });

  it('uses passenger-cancel base copy', () => {
    expect(buildRideCancellationBaseMessage('cancelled_by_passenger')).toBe('Your ride was cancelled.');
  });
});
