// Per-order Referral engine (dual-engine Phase S2).
//
// Distinct from Recruit (Invite & Earn / shared_ref_code / creditRecruiterShares):
// - One friend code on THIS order/trip only
// - Credits the code owner (friend), not a permanent recruiter of the buyer
// - Never creates shared_ref_code
// - Wallet source: 'referral_txn' (Recruit uses source:'recruit' as of S3)
//
// Rate is backend-only — never surface a % in product copy.
import prisma from './prisma-client.js';

const REFERRAL_TXN_SHARE_RATE = 0.01;
const CURRENCY = 'CAD';
export const REFERRAL_TXN_WALLET_SOURCE = 'referral_txn';

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export function normalizeReferralCode(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Cap length to schema VARCHAR(80)
  return s.slice(0, 80);
}

/**
 * Resolve the wallet user who owns a friend code / username.
 * Same lookup rules as Recruit apply, without creating a link.
 */
export async function resolveReferrerUserId(db, rawCode) {
  const typed = normalizeReferralCode(rawCode);
  if (!typed) return null;

  let owner = await db.user.findFirst({
    where: { ref_code: { equals: typed, mode: 'insensitive' } },
    select: { user_id: true },
  });
  if (!owner) {
    const byUsername = await db.user.findFirst({
      where: { username: { equals: typed, mode: 'insensitive' } },
      select: { user_id: true, ref_code: true },
    });
    if (byUsername?.ref_code) owner = byUsername;
  }
  return owner?.user_id ?? null;
}

/**
 * Credit the friend (code owner) for this order from platform take.
 * Returns the amount carved (0 if skipped). Never throws.
 */
export async function creditReferralForOrder({
  referralCode,
  buyerUserId = null,
  subtotal,
  platformTake,
  orderType,
  orderRef,
  tx = null,
} = {}) {
  try {
    const code = normalizeReferralCode(referralCode);
    if (!code || !orderType || orderRef == null) return 0;

    const db = tx || prisma;
    const sub = Number(subtotal);
    let budget = round2(Number(platformTake));
    if (!(sub > 0) || !(budget > 0)) return 0;

    const referrerId = await resolveReferrerUserId(db, code);
    if (!referrerId) return 0;
    // Self-referral: buyer cannot credit themselves.
    if (buyerUserId != null && Number(buyerUserId) === Number(referrerId)) return 0;

    const carve = round2(Math.min(sub * REFERRAL_TXN_SHARE_RATE, budget));
    if (!(carve > 0)) return 0;

    const externalRef = `referral_txn:${orderType}:${orderRef}`;
    const existing = await db.wallet_transaction.findFirst({
      where: { external_ref: externalRef },
      select: { transaction_id: true },
    });
    if (existing) return 0;

    const ensureWallet = async (c) => {
      const w = await c.strug_wallet.findUnique({ where: { user_id: referrerId } });
      if (!w) {
        await c.strug_wallet.create({
          data: { user_id: referrerId, balance: 0, currency: CURRENCY },
        });
      }
    };
    const write = async (c) => {
      await c.strug_wallet.update({
        where: { user_id: referrerId },
        data: { balance: { increment: carve } },
      });
      await c.wallet_transaction.create({
        data: {
          user_id: referrerId,
          amount: carve,
          type: 'credit',
          source: REFERRAL_TXN_WALLET_SOURCE,
          description: `Referral reward · ${orderType} #${orderRef}`,
          external_ref: externalRef,
        },
      });
    };

    if (tx) {
      await ensureWallet(db);
      await write(db);
    } else {
      await ensureWallet(prisma);
      try {
        await prisma.$transaction(async (t) => write(t));
      } catch (err) {
        if (err?.code === 'P2002') return 0;
        throw err;
      }
    }
    return carve;
  } catch (err) {
    console.error('[referral-txn] credit failed', { orderType, orderRef, msg: err?.message });
    return 0;
  }
}

/**
 * Run Referral then Recruit against the same platform-take budget so combined
 * carves never exceed platformTake.
 */
export async function settleReferralThenRecruit({
  referralCode,
  buyerUserId,
  recruitParticipantUserIds = [],
  subtotal,
  platformTake,
  orderType,
  orderRef,
  creditRecruiterShares,
  tx = null,
} = {}) {
  const take = round2(Number(platformTake) || 0);
  const carved = await creditReferralForOrder({
    referralCode,
    buyerUserId,
    subtotal,
    platformTake: take,
    orderType,
    orderRef,
    tx,
  });
  const remaining = round2(Math.max(0, take - Number(carved || 0)));
  if (remaining > 0 && typeof creditRecruiterShares === 'function') {
    await creditRecruiterShares({
      participantUserIds: recruitParticipantUserIds,
      subtotal,
      platformTake: remaining,
      orderType,
      orderRef,
      tx,
    });
  }
  return { referralCarve: carved, recruitBudget: remaining };
}

export const __private = { REFERRAL_TXN_SHARE_RATE, round2 };
