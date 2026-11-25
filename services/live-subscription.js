import Stripe from 'stripe';
import prisma from '../utils/prisma-client.js';
import { settleRecruiterShare } from '../utils/recruiter-settlement.js';

// ── Twitch-style paid livestream subscriptions ──────────────────────────────
// Auto-renewing monthly Stripe subscriptions. This module owns:
//   • config (price + creator/platform split, all env-overridable)
//   • Stripe customer/price provisioning
//   • the real `isSubscribed` check (replaces the faked follower gate in chat)
//   • idempotent webhook handlers (invoice.paid / *.deleted / payment_failed)
// The webhook router in booking-engine-routes.js dispatches the Stripe events here.

// M2: pin the Stripe API version so invoice.paid keeps the field shapes this module reads
// (invoice.subscription, invoice.subscription_details.metadata, invoice.lines[].period). If the
// account's default API version drifts forward, those fields can move/disappear and a paid
// invoice would fail to activate the sub / credit the creator. Override with STRIPE_API_VERSION.
const STRIPE_API_VERSION = process.env.STRIPE_API_VERSION || '2024-06-20';
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION })
  : null;

// Price is platform-wide and flat (one Stripe Price reused for every streamer;
// the streamer is attributed via subscription metadata + our DB, not separate
// Stripe products). Currency is CAD platform-wide.
export const SUB_CURRENCY = (process.env.SUB_CURRENCY || 'CAD').toUpperCase();
export const SUB_PRICE_CENTS = Math.round(Number(process.env.SUB_PRICE_CAD || 4.99) * 100);
// Share of each payment that accrues to the creator's wallet (rest is platform).
export const SUB_CREATOR_SHARE_RATIO = (() => {
  const r = Number(process.env.SUB_CREATOR_SHARE_RATIO);
  return Number.isFinite(r) && r >= 0 && r <= 1 ? r : 0.70;
})();

export function getStripe() {
  return stripe;
}

export function subscriptionPricing() {
  return {
    price_cents: SUB_PRICE_CENTS,
    currency: SUB_CURRENCY,
    creator_share_ratio: SUB_CREATOR_SHARE_RATIO,
    enabled: !!stripe,
  };
}

// Find or create the platform's recurring CAD/month Price. Cached in-memory and
// keyed by a deterministic lookup_key so we never create duplicate prices.
let cachedPriceId = process.env.STRIPE_LIVE_SUB_PRICE_ID || null;
export async function getOrCreatePrice() {
  if (!stripe) throw new Error('Stripe not configured');
  if (cachedPriceId) return cachedPriceId;
  const lookupKey = `strug_live_sub_${SUB_PRICE_CENTS}_${SUB_CURRENCY.toLowerCase()}_monthly`;
  const existing = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  if (existing.data.length > 0) {
    cachedPriceId = existing.data[0].id;
    return cachedPriceId;
  }
  const product = await stripe.products.create({
    name: 'Strug Channel Subscription',
    metadata: { kind: 'live_subscription' },
  });
  const price = await stripe.prices.create({
    unit_amount: SUB_PRICE_CENTS,
    currency: SUB_CURRENCY.toLowerCase(),
    recurring: { interval: 'month' },
    product: product.id,
    lookup_key: lookupKey,
  });
  cachedPriceId = price.id;
  return cachedPriceId;
}

// Find-or-create a Stripe customer for a user (keyed by email; no DB column needed).
export async function getOrCreateCustomer(userId) {
  if (!stripe) throw new Error('Stripe not configured');
  const user = await prisma.user.findUnique({
    where: { user_id: userId },
    select: { email: true, name: true },
  });
  if (!user?.email) throw new Error('User email required');
  const found = await stripe.customers.search({ query: `email:"${user.email}"`, limit: 1 });
  if (found.data.length > 0) return found.data[0];
  return stripe.customers.create({ email: user.email, name: user.name ?? undefined });
}

// THE real subscription check the chat gate uses. A subscription counts as active
// only while its paid period has not lapsed (Stripe extends current_period_end on
// each successful renewal invoice).
export async function isSubscribed(subscriberUserId, streamerId) {
  if (!subscriberUserId || !streamerId) return false;
  const sub = await prisma.live_subscription.findUnique({
    where: {
      subscriber_user_id_streamer_id: {
        subscriber_user_id: Number(subscriberUserId),
        streamer_id: Number(streamerId),
      },
    },
    select: { status: true, current_period_end: true },
  });
  if (!sub || sub.status !== 'active') return false;
  return !sub.current_period_end || sub.current_period_end > new Date();
}

function mapStripeStatus(s) {
  if (s === 'active' || s === 'trialing') return 'active';
  if (s === 'past_due' || s === 'unpaid') return 'past_due';
  if (s === 'canceled' || s === 'incomplete_expired') return 'canceled';
  return 'incomplete';
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// Split a paid amount (in cents) into creator/platform shares (in dollars).
// Pure + exported so the money math is unit-testable without Stripe/DB. The two
// shares always sum back to the full amount (platform absorbs the rounding).
export function computeSplit(amountCents, ratio = SUB_CREATOR_SHARE_RATIO) {
  const amount = (Number(amountCents) || 0) / 100;
  const creatorShare = round2(amount * ratio);
  const platformShare = round2(amount - creatorShare);
  return { creatorShare, platformShare };
}

// ── Webhook handlers (all idempotent; Stripe retries deliveries) ─────────────

// invoice.paid — the money event. Fires on the first charge AND every monthly
// renewal. Activates/extends the subscription and credits the creator's wallet.
// Idempotency: the unique stripe_invoice_id in live_subscription_payment means a
// re-delivered invoice can never double-credit.
export async function handleInvoicePaid(invoice) {
  const invoiceId = invoice.id;
  // M2: derive the subscription id defensively — across Stripe API versions it has lived on
  // invoice.subscription, invoice.parent.subscription_details.subscription, and the line item.
  const lineForSub = invoice.lines?.data?.[0] || {};
  const stripeSubId = invoice.subscription
    || invoice.parent?.subscription_details?.subscription
    || lineForSub.subscription
    || lineForSub.parent?.subscription_item_details?.subscription
    || null;
  if (!stripeSubId) return { handled: false, reason: 'no_subscription' };

  // Cheap idempotency short-circuit before doing any Stripe round-trips.
  const seen = await prisma.live_subscription_payment.findUnique({
    where: { stripe_invoice_id: invoiceId },
    select: { payment_id: true },
  });
  if (seen) return { handled: true, idempotent: true };

  // Read attribution + period straight off the invoice (Stripe mirrors the
  // subscription metadata into invoice.subscription_details.metadata and exposes
  // the billing period on the line items). Only fall back to a Stripe round-trip
  // when the invoice doesn't carry the metadata.
  const line = invoice.lines?.data?.[0] || {};
  let meta = invoice.subscription_details?.metadata
    || invoice.parent?.subscription_details?.metadata
    || {};
  let stripeSub = null;
  if (!meta.streamer_id) {
    // Authoritative fallback: pull the metadata straight off the subscription.
    stripeSub = await stripe.subscriptions.retrieve(stripeSubId);
    meta = stripeSub.metadata || {};
  }
  const streamerId = Number(meta.streamer_id);
  const subscriberUserId = meta.subscriber_user_id ? Number(meta.subscriber_user_id) : null;
  if (!Number.isInteger(streamerId) || streamerId <= 0) {
    console.error(`[live-sub] invoice.paid ${invoiceId}: missing streamer_id metadata`);
    return { handled: false, reason: 'no_streamer_meta' };
  }

  const streamer = await prisma.live_streamer_profile.findUnique({
    where: { streamer_id: streamerId },
    select: { streamer_id: true, user_id: true, handle: true },
  });
  if (!streamer) {
    console.error(`[live-sub] invoice.paid ${invoiceId}: streamer ${streamerId} not found`);
    return { handled: false, reason: 'streamer_gone' };
  }

  const amountCents = Number(invoice.amount_paid) || 0;
  const { creatorShare, platformShare } = computeSplit(amountCents);
  const periodEndUnix = line.period?.end ?? stripeSub?.current_period_end ?? null;
  const currentPeriodEnd = periodEndUnix ? new Date(periodEndUnix * 1000) : null;
  const priceId = line.price?.id ?? stripeSub?.items?.data?.[0]?.price?.id ?? undefined;
  const currency = (invoice.currency || SUB_CURRENCY).toUpperCase();

  try {
    await prisma.$transaction(async (tx) => {
      // Ledger row first — its unique invoice id is the idempotency guard.
      await tx.live_subscription_payment.create({
        data: {
          stripe_invoice_id: invoiceId,
          streamer_id: streamerId,
          subscriber_user_id: subscriberUserId,
          amount_cents: amountCents,
          currency,
          creator_share: creatorShare,
          platform_share: platformShare,
        },
      });

      // Activate / extend the subscription.
      if (subscriberUserId) {
        await tx.live_subscription.upsert({
          where: {
            subscriber_user_id_streamer_id: {
              subscriber_user_id: subscriberUserId,
              streamer_id: streamerId,
            },
          },
          update: {
            // A successful renewal clears past_due/cancel; cancel_at_period_end is
            // synced separately by customer.subscription.updated.
            status: 'active',
            current_period_end: currentPeriodEnd,
            stripe_subscription_id: stripeSubId,
            stripe_customer_id: invoice.customer || undefined,
            stripe_price_id: priceId,
            price_cents: amountCents || undefined,
            currency,
          },
          create: {
            subscriber_user_id: subscriberUserId,
            streamer_id: streamerId,
            status: 'active',
            current_period_end: currentPeriodEnd,
            stripe_subscription_id: stripeSubId,
            stripe_customer_id: invoice.customer || null,
            stripe_price_id: priceId || null,
            price_cents: amountCents || null,
            currency,
          },
        });
      } else {
        await tx.live_subscription.updateMany({
          where: { stripe_subscription_id: stripeSubId },
          data: { status: 'active', current_period_end: currentPeriodEnd },
        });
      }

      // Credit the creator's wallet (ensure the wallet exists). The creator is
      // paid regardless of monetization_status — they earned it; withdrawals
      // remain separately gated on APPROVED in live-wallet-routes.
      if (creatorShare > 0) {
        await tx.live_streamer_wallet.upsert({
          where: { streamer_id: streamerId },
          update: { balance: { increment: creatorShare } },
          create: {
            streamer_id: streamerId,
            user_id: streamer.user_id,
            balance: creatorShare,
            currency: SUB_CURRENCY,
          },
        });
        await tx.wallet_transaction.create({
          data: {
            user_id: streamer.user_id,
            amount: creatorShare,
            type: 'credit',
            source: 'live_subscription',
            description: `Channel subscription payout (invoice ${invoiceId})`,
          },
        });
      }
      // Platform share booked against the platform account (user_id 1), mirroring
      // the existing live ad-revenue settlement.
      if (platformShare > 0) {
        await tx.wallet_transaction.create({
          data: {
            user_id: 1,
            amount: platformShare,
            type: 'credit',
            source: 'live_subscription_tax',
            description: `Platform share from subscription to ${streamer.handle}`,
          },
        });
      }
    });
  } catch (err) {
    // Unique violation on stripe_invoice_id = a concurrent/duplicate delivery
    // already processed this invoice. Safe to treat as success.
    if (err?.code === 'P2002') return { handled: true, idempotent: true };
    throw err;
  }

  // Recruiter Phase 2 — platform_share is in cents (same unit as amount_paid).
  if (platformShare > 0) {
    await settleRecruiterShare({
      orderType: 'live_subscription',
      orderRef: invoiceId,
      participantUserIds: [streamer.user_id],
      subtotal: amountCents / 100,
      platformTake: platformShare / 100,
    });
  }

  return { handled: true, creatorShare, platformShare };
}

// checkout.session.completed — links the freshly-created Stripe subscription id to
// our pending row immediately (so status reads as active before the first renewal).
export async function handleCheckoutCompleted(session) {
  if (session.mode !== 'subscription' || !session.subscription) return { handled: false };
  const meta = session.metadata || {};
  const streamerId = Number(meta.streamer_id);
  const subscriberUserId = meta.subscriber_user_id
    ? Number(meta.subscriber_user_id)
    : (session.client_reference_id ? Number(session.client_reference_id) : null);
  if (!Number.isInteger(streamerId) || !subscriberUserId) return { handled: false };
  await prisma.live_subscription.updateMany({
    where: { subscriber_user_id: subscriberUserId, streamer_id: streamerId },
    data: {
      stripe_subscription_id: String(session.subscription),
      stripe_customer_id: session.customer ? String(session.customer) : undefined,
    },
  });
  return { handled: true };
}

// customer.subscription.updated — keep status/period/cancel flag in sync.
export async function handleSubscriptionUpdated(stripeSub) {
  const res = await prisma.live_subscription.updateMany({
    where: { stripe_subscription_id: stripeSub.id },
    data: {
      status: mapStripeStatus(stripeSub.status),
      cancel_at_period_end: !!stripeSub.cancel_at_period_end,
      current_period_end: stripeSub.current_period_end
        ? new Date(stripeSub.current_period_end * 1000)
        : undefined,
    },
  });
  return { handled: res.count > 0 };
}

// customer.subscription.deleted — fully ended (after period end, or hard cancel).
export async function handleSubscriptionDeleted(stripeSub) {
  const res = await prisma.live_subscription.updateMany({
    where: { stripe_subscription_id: stripeSub.id },
    data: { status: 'canceled', cancel_at_period_end: false },
  });
  return { handled: res.count > 0 };
}

// invoice.payment_failed — a renewal charge failed; move to past_due (access is
// then denied by isSubscribed). Stripe keeps retrying per dunning settings.
export async function handlePaymentFailed(invoice) {
  if (!invoice.subscription) return { handled: false };
  const res = await prisma.live_subscription.updateMany({
    where: { stripe_subscription_id: invoice.subscription },
    data: { status: 'past_due' },
  });
  return { handled: res.count > 0 };
}

// Single dispatch entry the webhook router calls for any subscription/invoice event.
export async function handleSubscriptionWebhookEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed':
      return handleCheckoutCompleted(event.data.object);
    case 'invoice.paid':
    case 'invoice.payment_succeeded':
      return handleInvoicePaid(event.data.object);
    case 'invoice.payment_failed':
      return handlePaymentFailed(event.data.object);
    case 'customer.subscription.updated':
      return handleSubscriptionUpdated(event.data.object);
    case 'customer.subscription.deleted':
      return handleSubscriptionDeleted(event.data.object);
    default:
      return { handled: false };
  }
}
