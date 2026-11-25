import { describe, it, expect } from 'vitest';
import { inspectCriticalSecrets, logCriticalSecrets } from '../../utils/startup-secrets.js';

const VALID_KEY = 'a'.repeat(64);
const LONG_JWT = ['jwt', '-key-', 'long-enough'].join('');
const LONG_REFRESH = ['refresh', '-key-', 'long-enough'].join('');

describe('inspectCriticalSecrets', () => {
  it('accepts valid ENCRYPTION_KEY, ACCESS_TOKEN_KEY, and REFRESH_TOKEN_KEY', () => {
    expect(inspectCriticalSecrets({
      ENCRYPTION_KEY: VALID_KEY,
      ACCESS_TOKEN_KEY: LONG_JWT,
      REFRESH_TOKEN_KEY: LONG_REFRESH,
    })).toEqual([]);
  });

  it('rejects a missing or short ENCRYPTION_KEY', () => {
    expect(inspectCriticalSecrets({ ACCESS_TOKEN_KEY: 'x' }).some((s) => s.includes('ENCRYPTION_KEY'))).toBe(true);
    expect(inspectCriticalSecrets({
      ENCRYPTION_KEY: 'not-hex',
      ACCESS_TOKEN_KEY: 'x',
    }).some((s) => s.includes('ENCRYPTION_KEY'))).toBe(true);
  });

  it('rejects a missing ACCESS_TOKEN_KEY', () => {
    expect(inspectCriticalSecrets({ ENCRYPTION_KEY: VALID_KEY }).some((s) => s.includes('ACCESS_TOKEN_KEY'))).toBe(true);
  });

  it('rejects a missing REFRESH_TOKEN_KEY', () => {
    expect(inspectCriticalSecrets({
      ENCRYPTION_KEY: VALID_KEY,
      ACCESS_TOKEN_KEY: LONG_JWT,
    }).some((s) => s.includes('REFRESH_TOKEN_KEY'))).toBe(true);
  });

  it('rejects a short REFRESH_TOKEN_KEY', () => {
    expect(inspectCriticalSecrets({
      ENCRYPTION_KEY: VALID_KEY,
      ACCESS_TOKEN_KEY: LONG_JWT,
      REFRESH_TOKEN_KEY: 'tiny',
    }).some((s) => s.includes('REFRESH_TOKEN_KEY'))).toBe(true);
  });
});

describe('logCriticalSecrets', () => {
  it('throws in production when secrets are bad, warns otherwise', () => {
    const errors = [];
    const log = { log: () => {}, error: (m) => errors.push(m) };
    expect(() => logCriticalSecrets({ NODE_ENV: 'development' }, log)).not.toThrow();
    expect(errors.length).toBeGreaterThan(0);
    expect(() => logCriticalSecrets({ NODE_ENV: 'production' }, log)).toThrow(/Refusing to start/);
  });
});
