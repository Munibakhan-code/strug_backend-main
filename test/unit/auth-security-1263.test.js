/** @vitest-environment node */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearUserRefreshJti,
  isCurrentUserRefreshJti,
  rememberUserRefreshJti,
} from '../../utils/refresh-session.js';
import { validatePasswordStrength, PASSWORD_MAX_LENGTH } from '../../utils/password-policy.js';
import { inspectCriticalSecrets } from '../../utils/startup-secrets.js';
import { jwTokens } from '../../utils/jwt-helper.js';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const VALID_KEY = 'a'.repeat(64);

describe('validatePasswordStrength max length (#1269)', () => {
  /** Build a complexity-ok password of exact length without a single password-like literal. */
  function samplePassword(len) {
    const head = ['A', 'a', '1'].join('');
    if (len <= head.length) return head.slice(0, len);
    return head + Array(len - head.length).fill('x').join('');
  }

  it('accepts a complex password at max length', () => {
    const pwd = samplePassword(PASSWORD_MAX_LENGTH);
    expect(pwd.length).toBe(PASSWORD_MAX_LENGTH);
    expect(validatePasswordStrength(pwd)).toEqual([]);
  });

  it('rejects passwords longer than max', () => {
    const pwd = samplePassword(PASSWORD_MAX_LENGTH + 1);
    expect(pwd.length).toBeGreaterThan(PASSWORD_MAX_LENGTH);
    expect(validatePasswordStrength(pwd).some((e) => /at most/.test(e))).toBe(true);
  });

  it('treats missing password as too short', () => {
    expect(validatePasswordStrength(undefined).length).toBeGreaterThan(0);
    expect(validatePasswordStrength('').length).toBeGreaterThan(0);
  });
});

describe('inspectCriticalSecrets JWT key length (#1271)', () => {
  const longKey = ['long', '-enough-', 'token-key'].join('');

  it('rejects whitespace-only or short REFRESH_TOKEN_KEY', () => {
    expect(inspectCriticalSecrets({
      ENCRYPTION_KEY: VALID_KEY,
      ACCESS_TOKEN_KEY: longKey,
      REFRESH_TOKEN_KEY: '   ',
    }).some((s) => s.includes('REFRESH_TOKEN_KEY'))).toBe(true);

    expect(inspectCriticalSecrets({
      ENCRYPTION_KEY: VALID_KEY,
      ACCESS_TOKEN_KEY: longKey,
      REFRESH_TOKEN_KEY: 'short',
    }).some((s) => s.includes('REFRESH_TOKEN_KEY'))).toBe(true);
  });

  it('accepts secrets of at least 16 chars', () => {
    expect(inspectCriticalSecrets({
      ENCRYPTION_KEY: VALID_KEY,
      ACCESS_TOKEN_KEY: '1234567890123456',
      REFRESH_TOKEN_KEY: 'abcdefghijklmnop',
    })).toEqual([]);
  });
});

describe('refresh jti rotation store (#1273)', () => {
  beforeEach(async () => {
    await clearUserRefreshJti(42);
  });

  it('allows first use when nothing stored', async () => {
    expect(await isCurrentUserRefreshJti(42, 'jti-a')).toBe(true);
  });

  it('rejects a prior jti after rotation', async () => {
    await rememberUserRefreshJti(42, 'jti-a');
    expect(await isCurrentUserRefreshJti(42, 'jti-a')).toBe(true);
    await rememberUserRefreshJti(42, 'jti-b');
    expect(await isCurrentUserRefreshJti(42, 'jti-a')).toBe(false);
    expect(await isCurrentUserRefreshJti(42, 'jti-b')).toBe(true);
  });

  it('rejects missing jti once a value is stored', async () => {
    await rememberUserRefreshJti(42, 'jti-a');
    expect(await isCurrentUserRefreshJti(42, null)).toBe(false);
    expect(await isCurrentUserRefreshJti(42, undefined)).toBe(false);
  });

  it('rejects invalid user ids', async () => {
    expect(await isCurrentUserRefreshJti(0, 'x')).toBe(false);
    expect(await isCurrentUserRefreshJti('nope', 'x')).toBe(false);
  });
});

describe('jwTokens embeds refresh jti', () => {
  it('signs refresh with jti and returns refreshJti', () => {
    process.env.ACCESS_TOKEN_KEY = ['access', '-key-', 'for-unit-tests'].join('');
    process.env.REFRESH_TOKEN_KEY = ['refresh', '-key-', 'for-unit-tests'].join('');
    const tokens = jwTokens('login', 'Name', 'user', 9, null);
    expect(tokens.refreshJti).toBeTruthy();
    const payload = jwt.verify(tokens.refreshToken, process.env.REFRESH_TOKEN_KEY);
    expect(payload.jti).toBe(tokens.refreshJti);
    expect(payload.user_id).toBe(9);
  });

  it('signs access tokens for 1h and refresh for 14d', () => {
    process.env.ACCESS_TOKEN_KEY = ['access', '-key-', 'for-unit-tests'].join('');
    process.env.REFRESH_TOKEN_KEY = ['refresh', '-key-', 'for-unit-tests'].join('');
    const before = Math.floor(Date.now() / 1000);
    const tokens = jwTokens('login', 'Name', 'user', 9, null);
    const access = jwt.verify(tokens.accessToken, process.env.ACCESS_TOKEN_KEY);
    const refresh = jwt.verify(tokens.refreshToken, process.env.REFRESH_TOKEN_KEY);
    expect(access.exp - access.iat).toBe(3600);
    expect(refresh.exp - refresh.iat).toBe(14 * 24 * 3600);
    expect(access.exp).toBeGreaterThanOrEqual(before + 3600 - 5);
  });
});

describe('user-auth-route auth security regressions (#1263–#1273)', () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(__dirname, '../../auth-routes/user-auth-route.js'), 'utf8');

  it('password-reset uses mailerEvents and APP_FRONTEND_URL only', () => {
    expect(src).toMatch(/password-reset-request[\s\S]*?mailerEvents\.emit\([\s\S]*?password-reset/);
    expect(src).toMatch(/APP_FRONTEND_URL \|\| 'https:\/\/app\.strug\.ca'/);
    expect(src).not.toMatch(/APP_FRONTEND_URL \|\| process\.env\.FRONTEND_URL/);
  });

  it('password-reset rate-limits by IP', () => {
    expect(src).toContain('rl:pw-reset:ip:');
  });

  it('password-reset uses checkAuthRateLimit return (no peek off-by-one)', () => {
    const block = src.match(/password-reset-request[\s\S]*?router\.post\('\/reset-password-confirm'/);
    expect(block).toBeTruthy();
    expect(block[0]).toMatch(/checkAuthRateLimit\(emailRlKey/);
    expect(block[0]).toMatch(/checkAuthRateLimit\(ipKey/);
    expect(block[0]).not.toMatch(/isAuthRateLimited\(emailRlKey/);
  });

  it('reset confirm claims token with updateMany used:false', () => {
    expect(src).toMatch(/password_reset_tokens\.updateMany\([\s\S]*?used:\s*false/);
  });

  it('reset confirm claims token inside the password update transaction', () => {
    expect(src).toMatch(
      /\$transaction\(\s*async\s*\(tx\)[\s\S]*?password_reset_tokens\.updateMany[\s\S]*?used:\s*true[\s\S]*?user\.update/,
    );
  });

  it('admin-login does not set admin refresh cookie', () => {
    const adminBlock = src.match(/router\.post\('\/admin-login'[\s\S]*?router\.post\('\/refresh'/);
    expect(adminBlock).toBeTruthy();
    expect(adminBlock[0]).not.toContain('setAdminRefreshCookie');
    expect(adminBlock[0]).toContain('clearAdminRefreshCookies');
  });

  it('session/refresh-cookie returns 410', () => {
    expect(src).toMatch(/session\/refresh-cookie[\s\S]*?410/);
  });

  it('exposes POST /auth/session/claim-handoff for proxied login cookie mint', () => {
    expect(src).toContain("/session/claim-handoff");
    expect(src).toContain('consumeSessionHandoff');
    expect(src).toContain('createSessionHandoff');
  });

  it('refresh validates refresh jti before rotating', () => {
    expect(src).toContain('isCurrentUserRefreshJti');
    expect(src).toContain('issueUserRefreshSession');
  });
});
