import { beforeEach, describe, expect, it } from 'vitest';
import { checkRiderAnalyticsGuard, resetRiderAnalyticsGuard } from '../../utils/rider-analytics-guard.js';

describe('rider analytics guard', () => {
  beforeEach(() => resetRiderAnalyticsGuard());

  it('allows normal volume and throttles only after sixty events in a minute', () => {
    for (let index = 0; index < 60; index += 1) {
      expect(checkRiderAnalyticsGuard(7, `event-${index}`, 1_000).throttled).toBe(false);
    }
    expect(checkRiderAnalyticsGuard(7, 'event-61', 1_000).throttled).toBe(true);
  });

  it('isolates users and resets after the window', () => {
    for (let index = 0; index < 61; index += 1) checkRiderAnalyticsGuard(7, `event-${index}`, 1_000);
    expect(checkRiderAnalyticsGuard(8, 'event', 1_000).throttled).toBe(false);
    expect(checkRiderAnalyticsGuard(7, 'event-after-window', 61_001).throttled).toBe(false);
  });

  it('deduplicates identical deliveries and exposes a deterministic reset', () => {
    expect(checkRiderAnalyticsGuard(7, 'same', 1_000).duplicate).toBe(false);
    expect(checkRiderAnalyticsGuard(7, 'same', 1_001).duplicate).toBe(true);
    resetRiderAnalyticsGuard();
    expect(checkRiderAnalyticsGuard(7, 'same', 1_002).duplicate).toBe(false);
  });

  it('preserves dedupe fingerprints across rate windows until their own expiry', () => {
    expect(checkRiderAnalyticsGuard(7, 'same', 1_000).duplicate).toBe(false);
    expect(checkRiderAnalyticsGuard(7, 'same', 61_001).duplicate).toBe(true);
    expect(checkRiderAnalyticsGuard(7, 'same', 301_001).duplicate).toBe(false);
  });

  it('returns deterministic retry-after seconds when throttled', () => {
    for (let index = 0; index < 60; index += 1) checkRiderAnalyticsGuard(7, `event-${index}`, 1_000);
    expect(checkRiderAnalyticsGuard(7, 'blocked', 30_000)).toEqual({
      throttled: true, duplicate: false, retryAfterSeconds: 31,
    });
    expect(checkRiderAnalyticsGuard(7, 'blocked-again', 60_999).retryAfterSeconds).toBe(1);
  });

  it('bounds user state by evicting the oldest bucket', () => {
    for (let userId = 1; userId <= 5_001; userId += 1) checkRiderAnalyticsGuard(userId, 'event', 1_000);
    expect(checkRiderAnalyticsGuard(1, 'event', 1_001).duplicate).toBe(false);
  });
});
