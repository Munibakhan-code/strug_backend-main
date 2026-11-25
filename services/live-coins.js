import Stripe from 'stripe';
import prisma from '../utils/prisma-client.js';
import { computeSplit } from './live-subscription.js';
import { settleRecruiterShare } from '../utils/recruiter-settlement.js';

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

export const COIN_CURRENCY = (process.env.LIVE_COIN_CURRENCY || 'CAD').toUpperCase();

/** Each coin represents 1 cent of fiat value when gifted (80/20 split applied on send). */
export const COIN_FIAT_CENTS = 1;

export const GIFT_CREATOR_SHARE_RATIO = (() => {
  const r = Number(process.env.LIVE_GIFT_CREATOR_SHARE_RATIO);
  return Number.isFinite(r) && r >= 0 && r <= 1 ? r : 0.80;
})();

export const COIN_PACKS = [
  { id: 'pack_100', coins: 100, amount_cents: 99, label: '100 Coins' },
  { id: 'pack_500', coins: 500, amount_cents: 499, label: '500 Coins' },
  { id: 'pack_1200', coins: 1200, amount_cents: 999, label: '1,200 Coins' },
  { id: 'pack_2500', coins: 2500, amount_cents: 1999, label: '2,500 Coins' },
];

/** Gift catalog — `icon` maps to FE SVG components in src/components/icons.jsx (no emoji). */
export const GIFT_CATALOG = [
  { key: 'rose', label: 'Rose', icon: 'rose', coins: 10 },
  { key: 'heart', label: 'Heart', icon: 'heart', coins: 50 },
  { key: 'star', label: 'Star', icon: 'star', coins: 100 },
  { key: 'crown', label: 'Crown', icon: 'crown', coins: 500 },
  { key: 'diamond', label: 'Diamond', icon: 'diamond', coins: 1000 },
];

export function getStripe() {
  return stripe;
}

export function coinCatalog() {
  return {
    currency: COIN_CURRENCY,
    coin_fiat_cents: COIN_FIAT_CENTS,
    creator_share_ratio: GIFT_CREATOR_SHARE_RATIO,
    packs: COIN_PACKS,
    gifts: GIFT_CATALOG,
    stripe_enabled: !!stripe,
  };
}

export function findPack(packId) {
  return COIN_PACKS.find((p) => p.id === packId) || null;
}

export function findGift(giftKey) {
  return GIFT_CATALOG.find((g) => g.key === giftKey) || null;
}

export async function getOrCreateCoinWallet(userId, tx = prisma) {
  return tx.live_coin_wallet.upsert({
    where: { user_id: userId },
    update: {},
    create: { user_id: userId, coin_balance: 0 },
  });
}

export async function createCoinPurchaseIntent(userId, packId, { idempotencyKey } = {}) {
  if (!stripe) throw Object.assign(new Error('Stripe not configured'), { code: 'STRIPE_UNAVAILABLE' });
  const pack = findPack(packId);
  if (!pack) throw Object.assign(new Error('Invalid coin pack'), { code: 'INVALID_PACK' });

  const key = idempotencyKey
    ? String(idempotencyKey).slice(0, 255)
    : `live-coins-${userId}-${pack.id}-${Math.floor(Date.now() / 30_000)}`;

  const intent = await stripe.paymentIntents.create({
    amount: pack.amount_cents,
    currency: COIN_CURRENCY.toLowerCase(),
    metadata: {
      purpose: 'live_coin_purchase',
      user_id: String(userId),
      pack_id: pack.id,
      coins: String(pack.coins),
    },
  }, { idempotencyKey: key });

  return { clientSecret: intent.client_secret, paymentIntentId: intent.id, pack };
}

/** Idempotent credit after Stripe confirms payment. */
export async function confirmCoinPurchase(userId, paymentIntentId) {
  if (!stripe) throw Object.assign(new Error('Stripe not configured'), { code: 'STRIPE_UNAVAILABLE' });
  const piId = String(paymentIntentId || '');
  if (!piId) throw Object.assign(new Error('payment_intent_id required'), { code: 'MISSING_PI' });

  const pi = await stripe.paymentIntents.retrieve(piId);
  if (!pi || pi.status !== 'succeeded') {
    throw Object.assign(new Error('Payment has not succeeded'), { code: 'NOT_SUCCEEDED' });
  }
  if (pi.metadata?.purpose !== 'live_coin_purchase' || pi.metadata?.user_id !== String(userId)) {
    throw Object.assign(new Error('Payment is not a coin purchase for this account'), { code: 'FORBIDDEN' });
  }

  const pack = findPack(pi.metadata.pack_id);
  const coins = pack?.coins ?? Number(pi.metadata.coins);
  if (!Number.isInteger(coins) || coins <= 0) {
    throw Object.assign(new Error('Invalid coin amount on payment'), { code: 'INVALID_COINS' });
  }

  const existing = await prisma.live_coin_purchase.findUnique({
    where: { stripe_payment_intent_id: piId },
  });
  if (existing) {
    const wallet = await getOrCreateCoinWallet(userId);
    return { credited: false, alreadyApplied: true, coins: existing.coins, balance: wallet.coin_balance };
  }

  const amountCents = pi.amount_received || pi.amount || pack?.amount_cents || 0;

  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.live_coin_purchase.create({
        data: {
          user_id: userId,
          pack_id: pack?.id || pi.metadata.pack_id || 'unknown',
          coins,
          amount_cents: amountCents,
          stripe_payment_intent_id: piId,
        },
      });
      const wallet = await tx.live_coin_wallet.upsert({
        where: { user_id: userId },
        update: { coin_balance: { increment: coins } },
        create: { user_id: userId, coin_balance: coins },
      });
      return { credited: true, coins, balance: wallet.coin_balance };
    }, { maxWait: 10000, timeout: 20000 });
    return result;
  } catch (e) {
    if (e?.code === 'P2002') {
      const wallet = await getOrCreateCoinWallet(userId);
      const row = await prisma.live_coin_purchase.findUnique({ where: { stripe_payment_intent_id: piId } });
      return { credited: false, alreadyApplied: true, coins: row?.coins ?? coins, balance: wallet.coin_balance };
    }
    throw e;
  }
}

/** Debit viewer coins and credit streamer wallet (80%) + platform ledger (20%). */
export async function sendGift({
  senderUserId,
  streamerId,
  sessionId = null,
  giftKey,
  message = null,
}) {
  const gift = findGift(giftKey);
  if (!gift) throw Object.assign(new Error('Unknown gift'), { code: 'INVALID_GIFT' });

  const streamer = await prisma.live_streamer_profile.findUnique({
    where: { streamer_id: Number(streamerId) },
    select: { streamer_id: true, user_id: true, handle: true, is_active: true },
  });
  if (!streamer || !streamer.is_active) {
    throw Object.assign(new Error('Streamer not found'), { code: 'STREAMER_NOT_FOUND' });
  }
  if (streamer.user_id === senderUserId) {
    throw Object.assign(new Error('Cannot gift yourself'), { code: 'SELF_GIFT' });
  }

  if (sessionId != null && sessionId !== '') {
    const sid = Number(sessionId);
    if (!Number.isInteger(sid)) {
      throw Object.assign(new Error('Invalid session'), { code: 'INVALID_SESSION' });
    }
    const session = await prisma.live_session.findFirst({
      where: {
        session_id: sid,
        streamer_id: streamer.streamer_id,
        status: { in: ['LIVE', 'STARTING'] },
      },
      select: { session_id: true },
    });
    if (!session) {
      throw Object.assign(new Error('Session not live for this streamer'), { code: 'INVALID_SESSION' });
    }
  }

  const fiatCents = gift.coins * COIN_FIAT_CENTS;
  const { creatorShare, platformShare } = computeSplit(fiatCents, GIFT_CREATOR_SHARE_RATIO);
  const trimmedMessage = message ? String(message).trim().slice(0, 200) : null;

  // Ensure the sender's wallet row exists BEFORE opening the transaction so we don't
  // spend part of the latency-bound transaction budget creating it.
  await getOrCreateCoinWallet(senderUserId);

  const giftRow = await prisma.$transaction(async (tx) => {
    const debit = await tx.live_coin_wallet.updateMany({
      where: { user_id: senderUserId, coin_balance: { gte: gift.coins } },
      data: { coin_balance: { decrement: gift.coins } },
    });
    if (debit.count !== 1) {
      throw Object.assign(new Error('Insufficient coins'), { code: 'INSUFFICIENT_COINS' });
    }

    const row = await tx.live_gift.create({
      data: {
        sender_user_id: senderUserId,
        streamer_id: streamer.streamer_id,
        session_id: sessionId ? Number(sessionId) : null,
        gift_key: gift.key,
        coins: gift.coins,
        fiat_cents: fiatCents,
        creator_share: creatorShare,
        platform_share: platformShare,
        message: trimmedMessage,
      },
      include: {
        sender: { select: { user_id: true, name: true, username: true } },
      },
    });

    if (creatorShare > 0) {
      await tx.live_streamer_wallet.upsert({
        where: { streamer_id: streamer.streamer_id },
        update: { balance: { increment: creatorShare } },
        create: {
          streamer_id: streamer.streamer_id,
          user_id: streamer.user_id,
          balance: creatorShare,
          currency: COIN_CURRENCY,
        },
      });
      await tx.wallet_transaction.create({
        data: {
          user_id: streamer.user_id,
          amount: creatorShare,
          type: 'credit',
          source: 'live_gift',
          description: `Live gift ${gift.label} (${gift.coins} coins)`,
        },
      });
    }

    // The platform's cut is already persisted on the live_gift row above
    // (`platform_share`), which is how every other vertical records it —
    // revenue_share_log.platform_share, live_subscription_payment.platform_share,
    // food_order.platform_fee, booking.service_fee. Board reporting aggregates that
    // column directly.
    //
    // This used to ALSO write a wallet_transaction credited to a PLATFORM_LEDGER_USER_ID
    // env var that defaulted to user_id 1 — duplicating the figure into a real person's
    // transaction history (it never moved a balance; strug_wallet is per-user and was
    // untouched). There is no platform account in the schema to credit, so the row is
    // dropped rather than pointed at a synthetic user.

    return row;
  }, {
    // The gift flow runs several sequential writes in one interactive transaction.
    // On a high-latency (remote) database the default 5s limit can expire mid-flight
    // and 500 the gift ("Transaction already closed"). Give it generous headroom.
    maxWait: 15000,
    timeout: 30000,
  });

  // Balance read is display-only, so do it OUTSIDE the transaction to keep the
  // transaction as short as possible (fewer round-trips = far less timeout risk).
  const wallet = await prisma.live_coin_wallet.findUnique({ where: { user_id: senderUserId } });

  // Recruiter Phase 2 — platform_share is stored in cents; convert to dollars for wallet carve.
  if (platformShare > 0 && giftRow?.id) {
    await settleRecruiterShare({
      orderType: 'live_gift',
      orderRef: giftRow.id,
      participantUserIds: [streamer.user_id],
      subtotal: fiatCents / 100,
      platformTake: platformShare / 100,
    });
  }

  return {
    gift: giftRow,
    gift_meta: gift,
    coin_balance: wallet?.coin_balance ?? 0,
    creator_share: creatorShare,
    platform_share: platformShare,
  };
}

export async function recentGifts({ streamerId, sessionId, limit = 20 }) {
  const where = {};
  if (streamerId) where.streamer_id = Number(streamerId);
  if (sessionId) where.session_id = Number(sessionId);

  const rows = await prisma.live_gift.findMany({
    where,
    orderBy: { created_at: 'desc' },
    take: Math.min(Math.max(Number(limit) || 20, 1), 50),
    include: {
      sender: { select: { user_id: true, name: true, username: true } },
    },
  });

  return rows.map((row) => ({
    ...row,
    gift: findGift(row.gift_key),
  }));
}
