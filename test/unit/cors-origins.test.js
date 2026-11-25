import { describe, it, expect } from 'vitest';
import { allowedOriginsFor, originAllowedBy, isStagingEnv } from '../../app.js';

const allows = (env, origin) => originAllowedBy(allowedOriginsFor(env), origin);

const LOCAL_DEV = 'http://localhost:5173';
const PROD_SPA = 'https://strug.ca';
const STAGING_SPA = 'https://staging.strug.ca';

describe('isStagingEnv', () => {
  it('is true ONLY for an explicit APP_ENV=staging', () => {
    expect(isStagingEnv({ APP_ENV: 'staging' })).toBe(true);
    expect(isStagingEnv({ APP_ENV: 'production' })).toBe(false);
    expect(isStagingEnv({ APP_ENV: 'Staging' })).toBe(false); // case-sensitive on purpose
    expect(isStagingEnv({})).toBe(false); // unset fails closed
  });
});

describe('CORS allowlist — production', () => {
  const PROD = { NODE_ENV: 'production', APP_ENV: 'production' };

  it('NEVER allows localhost', () => {
    expect(allows(PROD, LOCAL_DEV)).toBe(false);
    expect(allows(PROD, 'http://localhost:3000')).toBe(false);
    expect(allows(PROD, 'https://app.localhost:5173')).toBe(false);
  });

  it('does not allow preview/vercel wildcards', () => {
    expect(allows(PROD, 'https://strug-final-frontend-abc123.vercel.app')).toBe(false);
    expect(allows(PROD, 'https://random-preview.azurestaticapps.net')).toBe(false);
  });

  it('still allows the real prod origins', () => {
    expect(allows(PROD, PROD_SPA)).toBe(true);
    expect(allows(PROD, 'https://www.strug.ca')).toBe(true);
    expect(allows(PROD, STAGING_SPA)).toBe(true);
  });

  it('fails closed when APP_ENV is unset — an omitted var must not open prod up', () => {
    expect(allows({ NODE_ENV: 'production' }, LOCAL_DEV)).toBe(false);
  });

  it('fails closed on a typo\'d APP_ENV', () => {
    expect(allows({ NODE_ENV: 'production', APP_ENV: 'stagging' }, LOCAL_DEV)).toBe(false);
    expect(allows({ NODE_ENV: 'production', APP_ENV: '' }, LOCAL_DEV)).toBe(false);
  });
});

describe('CORS allowlist — staging', () => {
  // Staging deploys with NODE_ENV=production too; APP_ENV is what separates it.
  const STAGING = { NODE_ENV: 'production', APP_ENV: 'staging' };

  it('allows a local frontend to point at the staging API', () => {
    expect(allows(STAGING, LOCAL_DEV)).toBe(true);
    expect(allows(STAGING, 'http://localhost:3000')).toBe(true);
    expect(allows(STAGING, 'http://localhost:8081')).toBe(true);
  });

  it('does not allow an arbitrary port', () => {
    expect(allows(STAGING, 'http://localhost:9999')).toBe(false);
  });

  it('still allows the deployed origins', () => {
    expect(allows(STAGING, STAGING_SPA)).toBe(true);
    expect(allows(STAGING, PROD_SPA)).toBe(true);
  });
});

describe('CORS allowlist — local', () => {
  it('allows localhost when NODE_ENV is not production', () => {
    expect(allows({ NODE_ENV: 'development' }, LOCAL_DEV)).toBe(true);
  });
});

describe('CORS allowlist — hostile origins are rejected everywhere', () => {
  for (const env of [
    { NODE_ENV: 'production', APP_ENV: 'production' },
    { NODE_ENV: 'production', APP_ENV: 'staging' },
    { NODE_ENV: 'development' },
  ]) {
    const label = env.APP_ENV ?? env.NODE_ENV;
    it(`rejects lookalike domains under ${label}`, () => {
      expect(allows(env, 'https://strug.ca.evil.com')).toBe(false);
      expect(allows(env, 'https://evil-strug.ca')).toBe(false);
      expect(allows(env, 'http://localhost:5173.evil.com')).toBe(false);
    });
  }
});
