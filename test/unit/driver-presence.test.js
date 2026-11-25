import { describe, it, expect } from 'vitest';
import {
  isDriverPresentForDispatch,
  driverPresenceCutoff,
  DRIVER_PRESENCE_STALE_MS,
} from '../../utils/driver-presence.js';

describe('isDriverPresentForDispatch', () => {
  const now = Date.parse('2026-06-20T12:00:00.000Z');

  it('requires is_online=true and a recent last_ping', () => {
    expect(
      isDriverPresentForDispatch(
        { is_online: true, last_ping: new Date(now - 30_000) },
        now,
      ),
    ).toBe(true);
  });

  it('rejects offline drivers', () => {
    expect(
      isDriverPresentForDispatch(
        { is_online: false, last_ping: new Date(now - 30_000) },
        now,
      ),
    ).toBe(false);
  });

  it('rejects stale heartbeat even when is_online=true', () => {
    expect(
      isDriverPresentForDispatch(
        { is_online: true, last_ping: new Date(now - DRIVER_PRESENCE_STALE_MS - 1) },
        now,
      ),
    ).toBe(false);
  });

  it('rejects missing last_ping (ghost online from old session/seed)', () => {
    expect(isDriverPresentForDispatch({ is_online: true, last_ping: null }, now)).toBe(false);
  });
});

describe('driverPresenceCutoff', () => {
  it('returns a Date in the past', () => {
    const now = Date.now();
    expect(driverPresenceCutoff(now).getTime()).toBe(now - DRIVER_PRESENCE_STALE_MS);
  });
});
