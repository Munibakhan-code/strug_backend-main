// Recruit settlement helpers (Phase 2 + S1b receive-side).
//
// Thin wrapper around creditRecruiterShares. Callers MUST pass receive-side user ids only
// (provider / worker / host / streamer / campaign owner) — never the buyer/guest alone.
import { creditRecruiterShares } from './recruiter-share.js';
import { PLATFORM_FEE_PERCENTAGE } from './tax-config.js';

export { PLATFORM_FEE_PERCENTAGE };

/** Round money to 2dp (matches recruiter-share / raise-payout). */
export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Dedupe / drop nulls for receive-side participant lists.
 * @param {...(number|null|undefined)} ids
 * @returns {number[]}
 */
export function receiveSideUserIds(...ids) {
  return [...new Set(ids.filter((id) => id != null).map(Number))];
}

/**
 * Derive platform take from a percent of subtotal.
 * @param {number} subtotal
 * @param {number} [pct=PLATFORM_FEE_PERCENTAGE] — fraction e.g. 0.08
 */
export function platformTakeFromPct(subtotal, pct = PLATFORM_FEE_PERCENTAGE) {
  const sub = Number(subtotal);
  const rate = Number(pct);
  if (!(sub > 0) || !(rate > 0)) return 0;
  return round2(sub * rate);
}

/**
 * Preferred entry point for vertical settlement hooks.
 * `participantUserIds` = receive-side only (see receiveSideUserIds).
 * Never throws (creditRecruiterShares swallows errors).
 */
export async function settleRecruiterShare({
  orderType,
  orderRef,
  participantUserIds = [],
  subtotal,
  platformTake,
  tx = null,
} = {}) {
  return creditRecruiterShares({
    participantUserIds: receiveSideUserIds(...participantUserIds),
    subtotal,
    platformTake,
    orderType,
    orderRef,
    tx,
  });
}

/**
 * Convenience: platform take = subtotal × pct (default env PLATFORM_FEE).
 */
export async function settleRecruiterShareFromPct({
  orderType,
  orderRef,
  participantUserIds = [],
  subtotal,
  feePct = PLATFORM_FEE_PERCENTAGE,
  tx = null,
} = {}) {
  const sub = Number(subtotal) || 0;
  return settleRecruiterShare({
    orderType,
    orderRef,
    participantUserIds,
    subtotal: sub,
    platformTake: platformTakeFromPct(sub, feePct),
    tx,
  });
}

/**
 * Audit matrix for Phase 2. Status:
 * - wired: creditRecruiterShares / settleRecruiterShare on the settlement path
 * - deferred: money moves but Strug takes no fee at that moment (or fee rail missing)
 * - n/a: not a platform-fee transaction (wallet transfer, etc.)
 */
export const RECRUITER_SETTLEMENT_COVERAGE = Object.freeze({
  food: { status: 'wired', path: 'booking-engine reconcilePlatformPayment', receiveSide: 'vendor owner' },
  product: { status: 'wired', path: 'booking-engine reconcilePlatformPayment', receiveSide: 'seller' },
  dg: {
    status: 'deferred',
    reason: 'dg_content has no seller user_id; do not credit on buyer (receive-side only)',
  },
  booking: { status: 'wired', path: 'booking-engine stripe webhook purpose=booking', receiveSide: 'host' },
  ride: { status: 'wired', path: 'active_trip complete', receiveSide: 'driver' },
  work: { status: 'wired', path: 'work-routes job end/complete', receiveSide: 'worker' },
  freelance: { status: 'wired', path: 'booking-engine stripe webhook freelancerOrder PAID', receiveSide: 'freelancer' },
  artist: { status: 'wired', path: 'artist-booking-settlement creditArtistBookingOnPaid', receiveSide: 'artist' },
  celebrity: { status: 'wired', path: 'booking-engine handleCelebrityPaymentIntentSucceeded', receiveSide: 'celebrity' },
  service: { status: 'wired', path: 'service-order complete (WORK_GOV_TAX cut)', receiveSide: 'provider' },
  raise_payout: { status: 'wired', path: 'raise-payout markCampaignPayoutPaid (fee_amount)', receiveSide: 'campaign owner' },
  live_gift: { status: 'wired', path: 'live-coins sendGift platform_share', receiveSide: 'streamer' },
  live_subscription: { status: 'wired', path: 'live-subscription payment platform_share', receiveSide: 'streamer' },
  donation_checkout: {
    status: 'deferred',
    reason: 'No platform fee at donate time; fee taken later on campaign payout (raise_payout Recruit only)',
  },
  courier: {
    status: 'deferred',
    reason: 'Courier settlement does not yet expose a clear platform_fee carve on complete',
  },
  ads_wallet: {
    status: 'n/a',
    reason: 'Ads top-up/withdraw moves funds between wallets; no platform commission event',
  },
});

/** Per-order Referral (friend code) coverage — distinct from Recruit. */
export const REFERRAL_TXN_COVERAGE = Object.freeze({
  food: { status: 'wired', path: 'food create + reconcilePlatformPayment' },
  product: { status: 'wired', path: 'product-order create + reconcilePlatformPayment' },
  ride: { status: 'wired', path: 'ride-request create + active_trip complete' },
  booking: { status: 'wired', path: 'booking create + stripe webhook' },
  artist: { status: 'wired', path: 'artist-booking-settlement' },
  freelance: { status: 'wired', path: 'freelance-orders create + stripe webhook' },
  celebrity: { status: 'wired', path: 'celebrity bookings create + payment succeeded' },
  donation_checkout: {
    status: 'deferred',
    reason: 'Donations store referral_code; no platform-fee carve at donate time',
  },
  dg: { status: 'deferred', reason: 'No seller user_id for receive-side Recruit; Referral not wired' },
});

export function coverageStatuses() {
  return Object.fromEntries(
    Object.entries(RECRUITER_SETTLEMENT_COVERAGE).map(([k, v]) => [k, v.status]),
  );
}

export function wiredVerticals() {
  return Object.entries(RECRUITER_SETTLEMENT_COVERAGE)
    .filter(([, v]) => v.status === 'wired')
    .map(([k]) => k);
}
