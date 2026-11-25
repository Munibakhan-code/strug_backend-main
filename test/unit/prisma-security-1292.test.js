/**
 * #1292 / #1294 / #1296 prisma security: omit map + OTP hash/expiry helpers (no DB).
 */
import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { PRISMA_CLIENT_OMIT } from '../../utils/prisma-client.js';

const OTP_EXPIRY_MS = 15 * 60 * 1000;

function hashOtp(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function otpMatches(stored, provided) {
  if (!stored || provided == null) return false;
  return stored === hashOtp(provided);
}

function isEmailOtpExpired(verification) {
  if (!verification) return true;
  if (verification.used_at) return true;
  if (verification.expires_at) {
    return Date.now() > new Date(verification.expires_at).getTime();
  }
  return Date.now() - new Date(verification.created_at).getTime() > OTP_EXPIRY_MS;
}

function isCapabilityTokenExpired(expiresAt) {
  if (!expiresAt) return false;
  return Date.now() > new Date(expiresAt).getTime();
}

describe('PRISMA_CLIENT_OMIT (#1292)', () => {
  it('omits bank, withdrawal accounts, OTPs, driver KYC URL, ads tax, courier tracking', () => {
    expect(PRISMA_CLIENT_OMIT.bank_info.bank_account_number).toBe(true);
    expect(PRISMA_CLIENT_OMIT.withdrawalRequest.account_number).toBe(true);
    expect(PRISMA_CLIENT_OMIT.artistWithdrawalRequest.account_number).toBe(true);
    expect(PRISMA_CLIENT_OMIT.celebrityWithdrawalRequest.account_number).toBe(true);
    expect(PRISMA_CLIENT_OMIT.food_order.otp_code).toBe(true);
    expect(PRISMA_CLIENT_OMIT.active_trip.otp_code).toBe(true);
    expect(PRISMA_CLIENT_OMIT.active_trip.share_token).toBe(true);
    expect(PRISMA_CLIENT_OMIT.driver_document.document_url).toBe(true);
    expect(PRISMA_CLIENT_OMIT.driver_document.document_name).toBe(true);
    expect(PRISMA_CLIENT_OMIT.ads_account_profile.tax_id).toBe(true);
    expect(PRISMA_CLIENT_OMIT.ads_account_profile.brn).toBe(true);
    expect(PRISMA_CLIENT_OMIT.courier_order.tracking_token).toBe(true);
    expect(PRISMA_CLIENT_OMIT.event_plan.share_token).toBe(true);
    expect(PRISMA_CLIENT_OMIT.event_guest.invite_token).toBe(true);
  });

  it('keeps prior password and user KYC/location omits', () => {
    expect(PRISMA_CLIENT_OMIT.user.password).toBe(true);
    expect(PRISMA_CLIENT_OMIT.user.document_verification_document_url).toBe(true);
    expect(PRISMA_CLIENT_OMIT.user.saved_lat).toBe(true);
    expect(PRISMA_CLIENT_OMIT.admin.password).toBe(true);
  });

  it('constructs PrismaClient with the exported omit map without validation errors', async () => {
    const { PrismaClient } = await import('@prisma/client');
    expect(() => new PrismaClient({ omit: PRISMA_CLIENT_OMIT })).not.toThrow();
  });
});

describe('email OTP hash + expiry (#1294)', () => {
  it('matches hash only, never plaintext', () => {
    const stored = hashOtp('654321');
    expect(otpMatches(stored, '654321')).toBe(true);
    expect(otpMatches(stored, '000000')).toBe(false);
    expect(otpMatches('654321', '654321')).toBe(false);
  });

  it('expires on expires_at, used_at, or legacy created_at window', () => {
    const now = Date.now();
    expect(isEmailOtpExpired(null)).toBe(true);
    expect(isEmailOtpExpired({ used_at: new Date(), created_at: new Date() })).toBe(true);
    expect(isEmailOtpExpired({
      created_at: new Date(now),
      expires_at: new Date(now - 1000),
    })).toBe(true);
    expect(isEmailOtpExpired({
      created_at: new Date(now),
      expires_at: new Date(now + 60_000),
    })).toBe(false);
    expect(isEmailOtpExpired({
      created_at: new Date(now - OTP_EXPIRY_MS - 1000),
    })).toBe(true);
    expect(isEmailOtpExpired({
      created_at: new Date(now - 1000),
    })).toBe(false);
  });
});

describe('capability token expiry (#1296)', () => {
  it('treats null expires_at as legacy (still valid) and past dates as expired', () => {
    expect(isCapabilityTokenExpired(null)).toBe(false);
    expect(isCapabilityTokenExpired(undefined)).toBe(false);
    expect(isCapabilityTokenExpired(new Date(Date.now() - 1000))).toBe(true);
    expect(isCapabilityTokenExpired(new Date(Date.now() + 60_000))).toBe(false);
  });
});
