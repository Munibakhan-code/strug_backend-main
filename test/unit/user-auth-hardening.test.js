/**
 * Source-level regression checks for the auth hardening pass.
 * These don't need a DB — they assert the route module still exports the intended behavior
 * (Google merge, uid rate-limit, revoke-other-sessions, separate admin/user cookies).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const routePath = path.join(__dirname, '../../auth-routes/user-auth-route.js');
const src = fs.readFileSync(routePath, 'utf8');

describe('user-auth-route hardening regressions', () => {
  it('allows Google login for password accounts (no PASSWORD_ACCOUNT_EXISTS block)', () => {
    expect(src).not.toContain('PASSWORD_ACCOUNT_EXISTS');
  });

  it('rate-limits failed login by resolved user_id as well as typed login', () => {
    expect(src).toContain('rl:login:uid:');
    expect(src).toMatch(/clearRateLimit\(uidKey\)/);
    // Locked uid must not return 429 (account-exists oracle); same 401 as unknown accounts.
    expect(src).toMatch(/isAuthRateLimited\(uidKey,\s*5\)[\s\S]*?invalidCredentials/);
  });

  it('exposes POST /auth/revoke-other-sessions', () => {
    expect(src).toContain("/revoke-other-sessions");
    expect(src).toContain('sessions_invalidated_at');
  });

  it('setRefreshCookie does not wipe the admin refresh cookie', () => {
    const m = src.match(/function setRefreshCookie[\s\S]*?\nfunction /);
    expect(m).toBeTruthy();
    expect(m[0]).not.toContain('clearAdminRefreshCookies');
  });

  it('setAdminRefreshCookie does not wipe the user refresh cookie', () => {
    const m = src.match(/function setAdminRefreshCookie[\s\S]*?\nfunction /);
    expect(m).toBeTruthy();
    expect(m[0]).not.toContain('clearUserRefreshCookies');
  });

  it('refresh token remains cookie-only (no body JWT accept)', () => {
    expect(src).toMatch(/Cookie-only: do not accept refresh JWTs from the request body/);
  });

  it('does not mint refresh from access via session/refresh-cookie', () => {
    expect(src).toMatch(/session\/refresh-cookie[\s\S]*?410/);
  });

  it('register-request returns usernameTaken early (does not fake OTP success)', () => {
    const m = src.match(/router\.post\('\/register-request'[\s\S]*?router\.post\('\/verify-otp-and-register'/);
    expect(m).toBeTruthy();
    const block = m[0];
    expect(block).toMatch(/sendError\(res,\s*409,\s*req,\s*'auth\.usernameTaken'\)/);
    // Taken username must not share the email anti-enumeration success path.
    expect(block).not.toMatch(/if\s*\(\s*existing\s*\|\|\s*usernameTaken\s*\)/);
  });

  it('returns social profile creation metadata for account-switch onboarding gates', () => {
    expect(src.match(/select:\s*\{\s*profile_id:\s*true,\s*created_at:\s*true\s*\}/g)?.length).toBeGreaterThanOrEqual(3);
    expect(src.match(/social_created_at:\s*socialProfile\.created_at/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('verify-otp-and-register returns the created social profile metadata immediately', () => {
    const m = src.match(/router\.post\('\/verify-otp-and-register'[\s\S]*?router\.post\('\/password-reset-request'/);
    expect(m).toBeTruthy();
    const block = m[0];
    expect(block).toMatch(/\[newUser,\s*newProfile\]\s*=\s*await prisma\.\$transaction/);
    expect(block).toMatch(/const createdProfile = await tx\.social_profile\.create/);
    expect(block).toMatch(/return \[createdUser,\s*createdProfile\]/);
    expect(block).toMatch(/profile_id:\s*newProfile\.profile_id/);
    expect(block).toMatch(/social_created_at:\s*newProfile\.created_at/);
  });
});
