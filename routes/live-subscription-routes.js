import express from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import {
  getStripe,
  getOrCreateCustomer,
  getOrCreatePrice,
  isSubscribed,
  subscriptionPricing,
  SUB_PRICE_CENTS,
  SUB_CURRENCY,
} from '../services/live-subscription.js';

const router = express.Router();

const checkoutSchema = z.object({
  streamer_id: z.number().int().positive().optional(),
  handle: z.string().min(1).max(50).optional(),
}).refine((d) => d.streamer_id || d.handle, { message: 'streamer_id or handle required' });

const cancelSchema = z.object({
  streamer_id: z.number().int().positive(),
});

async function resolveStreamer({ streamer_id, handle }) {
  if (streamer_id) {
    return prisma.live_streamer_profile.findUnique({
      where: { streamer_id },
      select: { streamer_id: true, user_id: true, handle: true, display_name: true, monetization_status: true },
    });
  }
  return prisma.live_streamer_profile.findUnique({
    where: { handle },
    select: { streamer_id: true, user_id: true, handle: true, display_name: true, monetization_status: true },
  });
}

// Subscriptions are only offered once a channel is approved for monetization
// (mirrors Twitch Affiliate gating + the existing payout/ad-revenue gate). We
// never want to collect a recurring charge for a creator who can't be paid out.
function subsEnabled(streamer) {
  return streamer?.monetization_status === 'APPROVED';
}

// Public pricing so the FE can render the subscribe button/price without auth.
router.get('/pricing', (_req, res) => {
  return res.json({ successful: true, ...subscriptionPricing() });
});

// POST /live-subscription/checkout — start a hosted Stripe Checkout (mode:subscription).
// Returns { url } for the client to redirect to. The subscription is finalized
// server-side by the webhook (invoice.paid).
router.post('/checkout', authenticateToken, async (req, res, next) => {
  try {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ successful: false, message: 'Stripe not configured' });

    const body = checkoutSchema.parse(req.body);
    const streamer = await resolveStreamer(body);
    if (!streamer) return res.status(404).json({ successful: false, message: 'Streamer_Not_Found' });

    if (streamer.user_id === req.user.user_id) {
      return res.status(400).json({ successful: false, message: 'Cannot_Subscribe_To_Self' });
    }

    if (!subsEnabled(streamer)) {
      return res.status(403).json({ successful: false, message: 'Monetization_Not_Enabled' });
    }

    // Already actively subscribed? Don't create a second subscription.
    if (await isSubscribed(req.user.user_id, streamer.streamer_id)) {
      return res.status(409).json({ successful: false, message: 'Already_Subscribed' });
    }

    const [customer, priceId] = await Promise.all([
      getOrCreateCustomer(req.user.user_id),
      getOrCreatePrice(),
    ]);

    // M1: a prior abandoned checkout can leave a non-active Stripe subscription attached to the
    // existing row. Creating a fresh Checkout session would then spawn a SECOND Stripe sub for the
    // same (subscriber, streamer) pair — and if both ever charge, the row only tracks one, leaving
    // the other as a ghost recurring charge. Cancel any lingering non-active/non-canceled Stripe
    // sub before starting a new checkout. Best-effort: a Stripe error here must not block checkout.
    const existingRow = await prisma.live_subscription.findUnique({
      where: {
        subscriber_user_id_streamer_id: {
          subscriber_user_id: req.user.user_id,
          streamer_id: streamer.streamer_id,
        },
      },
      select: { stripe_subscription_id: true, status: true },
    });
    if (existingRow?.stripe_subscription_id && !['active', 'canceled'].includes(existingRow.status)) {
      try {
        const prior = await stripe.subscriptions.retrieve(existingRow.stripe_subscription_id);
        if (prior && !['active', 'canceled'].includes(prior.status)) {
          await stripe.subscriptions.cancel(existingRow.stripe_subscription_id);
        }
      } catch (e) {
        console.warn('[live-sub] could not cancel prior incomplete subscription:', e?.message);
      }
    }

    // Upsert a pending row so we have a record even before the webhook lands.
    await prisma.live_subscription.upsert({
      where: {
        subscriber_user_id_streamer_id: {
          subscriber_user_id: req.user.user_id,
          streamer_id: streamer.streamer_id,
        },
      },
      update: {
        status: 'incomplete',
        cancel_at_period_end: false,
        stripe_customer_id: customer.id,
        stripe_price_id: priceId,
        price_cents: SUB_PRICE_CENTS,
        currency: SUB_CURRENCY,
      },
      create: {
        subscriber_user_id: req.user.user_id,
        streamer_id: streamer.streamer_id,
        status: 'incomplete',
        stripe_customer_id: customer.id,
        stripe_price_id: priceId,
        price_cents: SUB_PRICE_CENTS,
        currency: SUB_CURRENCY,
      },
    });

    const base = (process.env.FRONTEND_URL || 'https://app.strug.ca').replace(/\/$/, '');
    const meta = {
      purpose: 'live_subscription',
      streamer_id: String(streamer.streamer_id),
      subscriber_user_id: String(req.user.user_id),
      streamer_handle: streamer.handle,
    };

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customer.id,
      client_reference_id: String(req.user.user_id),
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${base}/live/@${streamer.handle}?sub=success`,
      cancel_url: `${base}/live/@${streamer.handle}?sub=cancelled`,
      metadata: meta,
      subscription_data: { metadata: meta },
    });

    return res.json({ successful: true, url: session.url });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, message: (err.issues ?? err.errors)[0]?.message || 'Invalid input' });
    }
    next(err);
  }
});

// POST /live-subscription/cancel — cancel at period end (keeps access until paid
// through, Twitch-style). Webhook flips status to canceled when the period ends.
router.post('/cancel', authenticateToken, async (req, res, next) => {
  try {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ successful: false, message: 'Stripe not configured' });

    const { streamer_id } = cancelSchema.parse(req.body);
    const sub = await prisma.live_subscription.findUnique({
      where: {
        subscriber_user_id_streamer_id: {
          subscriber_user_id: req.user.user_id,
          streamer_id,
        },
      },
    });
    if (!sub || !sub.stripe_subscription_id || sub.status === 'canceled') {
      return res.status(404).json({ successful: false, message: 'No_Active_Subscription' });
    }

    await stripe.subscriptions.update(sub.stripe_subscription_id, { cancel_at_period_end: true });
    await prisma.live_subscription.update({
      where: { subscription_id: sub.subscription_id },
      data: { cancel_at_period_end: true },
    });

    return res.json({ successful: true, message: 'Will_Cancel_At_Period_End', current_period_end: sub.current_period_end });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, message: 'Invalid input' });
    }
    next(err);
  }
});

// GET /live-subscription/status/:streamer_id — the caller's subscription state for
// a streamer (drives the subscribe/manage button + badge).
router.get('/status/:streamer_id', authenticateToken, async (req, res, next) => {
  try {
    const streamerId = Number(req.params.streamer_id);
    if (!Number.isInteger(streamerId) || streamerId <= 0) {
      return res.status(400).json({ successful: false, message: 'Invalid streamer id' });
    }
    const [sub, streamer] = await Promise.all([
      prisma.live_subscription.findUnique({
        where: {
          subscriber_user_id_streamer_id: {
            subscriber_user_id: req.user.user_id,
            streamer_id: streamerId,
          },
        },
        select: { status: true, current_period_end: true, cancel_at_period_end: true, price_cents: true, currency: true },
      }),
      prisma.live_streamer_profile.findUnique({
        where: { streamer_id: streamerId },
        select: { monetization_status: true },
      }),
    ]);
    const subscribed = await isSubscribed(req.user.user_id, streamerId);
    return res.json({
      successful: true,
      subscribed,
      subscriptions_enabled: subsEnabled(streamer),
      status: sub?.status || 'none',
      current_period_end: sub?.current_period_end || null,
      cancel_at_period_end: sub?.cancel_at_period_end || false,
      price_cents: sub?.price_cents ?? SUB_PRICE_CENTS,
      currency: sub?.currency || SUB_CURRENCY,
    });
  } catch (err) {
    next(err);
  }
});

// GET /live-subscription/subscribers — the calling streamer's own subscriber list.
router.get('/subscribers', authenticateToken, async (req, res, next) => {
  try {
    const streamer = await prisma.live_streamer_profile.findUnique({
      where: { user_id: req.user.user_id },
      select: { streamer_id: true },
    });
    if (!streamer) return res.status(404).json({ successful: false, message: 'Not_A_Streamer' });

    const where = {
      streamer_id: streamer.streamer_id,
      status: 'active',
      OR: [{ current_period_end: null }, { current_period_end: { gt: new Date() } }],
    };
    const [count, subs] = await Promise.all([
      prisma.live_subscription.count({ where }),
      prisma.live_subscription.findMany({
        where,
        orderBy: { current_period_end: 'desc' },
        take: 200,
        select: {
          current_period_end: true,
          cancel_at_period_end: true,
          created_at: true,
          subscriber: { select: { user_id: true, name: true } },
        },
      }),
    ]);

    return res.json({ successful: true, count, subscribers: subs });
  } catch (err) {
    next(err);
  }
});

export default router;
