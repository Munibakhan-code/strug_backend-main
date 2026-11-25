import { describe, it, expect } from 'vitest';
import {
  computePassengerRefundAmount,
  resolvePassengerCancelFeeRate,
  formatCancelFeePct,
} from '../../utils/ride-refund.js';

describe('computePassengerRefundAmount', () => {
  it('returns full amount when cancel fee rate is 0 (v1 default)', () => {
    expect(computePassengerRefundAmount(17.17, 0)).toBe(17.17);
  });

  it('returns 70% when cancel fee rate is 0.30 (after driver accepts)', () => {
    expect(computePassengerRefundAmount(10, 0.3)).toBe(7);
    expect(computePassengerRefundAmount(24.76, 0.3)).toBe(17.33);
  });

  it('returns 0 for invalid or zero paid amounts', () => {
    expect(computePassengerRefundAmount(0, 0)).toBe(0);
    expect(computePassengerRefundAmount(null, 0)).toBe(0);
  });
});

describe('resolvePassengerCancelFeeRate', () => {
  it('charges 30% only after driver accepts', () => {
    expect(resolvePassengerCancelFeeRate('pending', 'cancelled_by_passenger')).toBe(0);
    expect(resolvePassengerCancelFeeRate('accepted', 'cancelled_by_passenger')).toBe(0.3);
  });

  it('never charges fee on system cancel reasons', () => {
    expect(resolvePassengerCancelFeeRate('accepted', 'no_driver_found')).toBe(0);
    expect(resolvePassengerCancelFeeRate('accepted', 'all_drivers_declined')).toBe(0);
  });
});

describe('formatCancelFeePct', () => {
  it('derives the whole-number % from the actual fee/paid split', () => {
    expect(formatCancelFeePct(7.43, 24.76)).toBe(30); // 7.43 / 24.76 ≈ 30%
    expect(formatCancelFeePct(3, 12)).toBe(25);
  });

  it('falls back to the configured passenger rate when paid amount is unknown', () => {
    expect(formatCancelFeePct(5, 0)).toBe(30);
    expect(formatCancelFeePct(5, null)).toBe(30);
  });
});
