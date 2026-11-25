/**
 * #1286–#1288: payment amount allowlist, PayPal custom_id bind, auth RL Redis default, SSRF image fetch.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  paypalCustomId,
  parsePaypalCustomId,
  resolvePaymentChargeAmount,
} from '../../routes/payment-routes.js';
import { authRateLimitRequiresRedis } from '../../utils/rate-limiter.js';
import { downloadImageBuffer } from '../../utils/image-upload.js';

describe('PayPal custom_id bind (#1286)', () => {
  it('round-trips user id and amount', () => {
    const id = paypalCustomId(42, 19.5);
    expect(id).toBe('u:42|a:19.50');
    expect(parsePaypalCustomId(id)).toEqual({ userId: 42, amount: 19.5 });
  });

  it('rejects malformed custom_id', () => {
    expect(parsePaypalCustomId('ride-99')).toBeNull();
    expect(parsePaypalCustomId('')).toBeNull();
    expect(parsePaypalCustomId(null)).toBeNull();
    expect(parsePaypalCustomId('u:x|a:1.00')).toBeNull();
  });
});

describe('resolvePaymentChargeAmount (#1286)', () => {
  it('rejects unsupported purpose without ride', async () => {
    const r = await resolvePaymentChargeAmount({
      userId: 1,
      amount: 50,
      purpose: 'mystery',
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });

  it('rejects booking purpose without listing quote fields or booking_id', async () => {
    const r = await resolvePaymentChargeAmount({
      userId: 1,
      amount: 500,
      purpose: 'booking',
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });

  it('rejects commerce with empty items before trusting amount', async () => {
    const r = await resolvePaymentChargeAmount({
      userId: 1,
      amount: 0.01,
      purpose: 'commerce',
      items: [],
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });

  it('accepts allowlisted donation amounts in range', async () => {
    const r = await resolvePaymentChargeAmount({
      userId: 1,
      amount: 25,
      purpose: 'donation',
    });
    expect(r.ok).toBe(true);
    expect(r.amount).toBe(25);
  });
});

describe('authRateLimitRequiresRedis (#1288)', () => {
  const keys = ['AUTH_RATE_LIMIT_REQUIRE_REDIS', 'REDIS_URL', 'APP_ENV', 'NODE_ENV'];
  const snap = {};

  beforeEach(() => {
    for (const k of keys) snap[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of keys) {
      if (snap[k] === undefined) delete process.env[k];
      else process.env[k] = snap[k];
    }
  });

  it('honours explicit 1 / 0', () => {
    process.env.AUTH_RATE_LIMIT_REQUIRE_REDIS = '1';
    expect(authRateLimitRequiresRedis()).toBe(true);
    process.env.AUTH_RATE_LIMIT_REQUIRE_REDIS = '0';
    process.env.REDIS_URL = 'redis://x';
    process.env.NODE_ENV = 'production';
    process.env.APP_ENV = 'production';
    expect(authRateLimitRequiresRedis()).toBe(false);
  });

  it('auto-enables when REDIS_URL set on production and not staging', () => {
    delete process.env.AUTH_RATE_LIMIT_REQUIRE_REDIS;
    process.env.REDIS_URL = 'redis://example:6379';
    process.env.NODE_ENV = 'production';
    process.env.APP_ENV = 'production';
    expect(authRateLimitRequiresRedis()).toBe(true);

    process.env.APP_ENV = 'staging';
    expect(authRateLimitRequiresRedis()).toBe(false);
  });

  it('stays off without REDIS_URL', () => {
    delete process.env.AUTH_RATE_LIMIT_REQUIRE_REDIS;
    delete process.env.REDIS_URL;
    process.env.NODE_ENV = 'production';
    process.env.APP_ENV = 'production';
    expect(authRateLimitRequiresRedis()).toBe(false);
  });
});

describe('downloadImageBuffer uses ssrf-guard (#1287)', () => {
  it('rejects private / metadata URLs', async () => {
    await expect(downloadImageBuffer('http://127.0.0.1/secret.png')).rejects.toThrow(/SSRF blocked/);
    await expect(downloadImageBuffer('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/SSRF blocked/);
    await expect(downloadImageBuffer('file:///etc/passwd')).rejects.toThrow(/SSRF blocked/);
  });
});
