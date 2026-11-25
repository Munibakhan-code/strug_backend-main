import express from 'express';
import Stripe from 'stripe';
import paypal from '@paypal/checkout-server-sdk';
import { authenticateToken } from '../middleware/authentication.js';
import prisma from '../utils/prisma-client.js';
import { decrypt } from '../utils/crypto.js';
import {
  SHIPPING_FEES,
  computeCommerceCartAmount,
  detectCartSource,
  resolveCommerceShippingFee,
  resolveLinePrices,
  totalFromLines,
} from '../utils/commerce-pricing.js';
import { computeUnits, computeQuote } from '../services/booking-engine.js';
import { validatePartySize } from '../utils/booking-capacity.js';
import { validateChargeAmount, buildStripeIdempotencyKey } from '../utils/ride-payment-safety.js';
const router = express.Router();

export {
  SHIPPING_FEES,
  computeCommerceCartAmount,
  resolveCommerceShippingFee,
  resolveLinePrices,
  totalFromLines,
};

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
if (stripe) console.log("Stripe mode:", process.env.STRIPE_SECRET_KEY?.startsWith("sk_test") ? "TEST" : "LIVE");
else console.warn("[payment] STRIPE_SECRET_KEY not set — Stripe endpoints disabled");

// Select the PayPal environment from an explicit PAYPAL_ENV (`live` | `sandbox`),
// NOT from NODE_ENV. Staging runs NODE_ENV=production but must talk to the PayPal
// SANDBOX, so the old NODE_ENV switch made sandbox testing on staging impossible.
// Default is sandbox: a missing/typo'd PAYPAL_ENV can never accidentally hit the
// live money endpoint — going live is an explicit, deliberate `PAYPAL_ENV=live`.
export function isPayPalLive() {
  return String(process.env.PAYPAL_ENV || '').trim().toLowerCase() === 'live';
}

function getPayPalClient() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const env = isPayPalLive()
    ? new paypal.core.LiveEnvironment(clientId, clientSecret)
    : new paypal.core.SandboxEnvironment(clientId, clientSecret);
  return new paypal.core.PayPalHttpClient(env);
}

if (process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET) {
  console.log('PayPal mode:', isPayPalLive() ? 'LIVE' : 'SANDBOX');
} else {
  console.warn('[payment] PAYPAL_CLIENT_ID/SECRET not set — PayPal endpoints will fail until configured');
}

async function loadRideAwaitingPayment(rideRequestId, userId) {
  const id = Number(rideRequestId);
  if (!id || Number.isNaN(id)) {
    return { error: 'Invalid ride_request_id', status: 400 };
  }
  const ride = await prisma.ride_request.findUnique({ where: { ride_request_id: id } });
  if (!ride) return { error: 'Ride not found', status: 404 };
  if (ride.passenger_id !== userId) {
    return { error: 'Unauthorized — this ride does not belong to you', status: 403 };
  }
  if (ride.status !== 'pending_payment') {
    return { error: 'Ride is not awaiting payment', status: 409 };
  }
  return { ride };
}

// #1286: only allowlisted purposes may create intents. Commerce/ride are server-priced;
// donation / dating_worth_it may use a bounded client amount (user-chosen).
const CLIENT_AMOUNT_PURPOSES = new Set(['donation', 'dating_worth_it']);

/**
 * Resolve charge amount or return an HTTP error payload.
 * @returns {{ ok: true, amount: number } | { ok: false, status: number, error: string }}
 */
export async function resolvePaymentChargeAmount({
  userId,
  amount,
  ride,
  purpose,
  vertical,
  items,
  tip,
  shipping_mode,
  item_source,
  seller_id,
  shipping_country,
  shipping_address,
  shipping_city,
  shipping_lat,
  shipping_lng,
  promo_code,
  booking_id,
  booking_listing_id,
  start_date,
  end_date,
  guests,
  quantity,
  start_time,
  end_time,
}) {
  if (ride) {
    return validateChargeAmount(amount, { ride });
  }

  if (purpose === 'booking') {
    return resolveBookingChargeAmount({
      userId,
      booking_id,
      booking_listing_id,
      start_date,
      end_date,
      guests,
      quantity,
      start_time,
      end_time,
    });
  }

  if (purpose === 'commerce') {
    if (!Array.isArray(items) || !items.length) {
      return { ok: false, status: 400, error: 'Commerce payments require a non-empty items cart' };
    }
    const buyer = await prisma.user.findUnique({
      where: { user_id: userId },
      select: { country: true, saved_address: true },
    });
    const computed = await computeCommerceCartAmount({
      items,
      country: shipping_country || buyer?.country,
      tip,
      shippingMode: shipping_mode,
      source: item_source,
      sellerId: seller_id,
      city: shipping_city,
      lat: shipping_lat,
      lng: shipping_lng,
      deliveryLocation: shipping_address || (shipping_lat != null && shipping_lng != null ? null : buyer?.saved_address),
      promoCode: promo_code,
      userId,
    });
    if (!computed.ok) {
      console.warn(`[payment] commerce cart not server-priced (source=${item_source || '?'}, vertical=${vertical || '?'}) — refusing client amount`);
      return { ok: false, status: computed.status || 400, error: computed.error || 'Could not price cart' };
    }
    return validateChargeAmount(computed.amount, { ride: null });
  }

  if (CLIENT_AMOUNT_PURPOSES.has(purpose)) {
    return validateChargeAmount(amount, { ride: null });
  }

  return {
    ok: false,
    status: 400,
    error: 'Unsupported payment purpose. Use rideshare (with ride_request_id), commerce (with items), booking (with booking_id or listing quote fields), donation, or dating_worth_it.',
  };
}

/** Server-price a booking charge from an existing booking row or a listing quote (#1286). */
async function resolveBookingChargeAmount({
  userId,
  booking_id,
  booking_listing_id,
  start_date,
  end_date,
  guests,
  quantity,
  start_time,
  end_time,
}) {
  const bookingId = Number(booking_id);
  if (booking_id != null && Number.isInteger(bookingId) && bookingId > 0) {
    const booking = await prisma.booking.findUnique({ where: { booking_id: bookingId } });
    if (!booking) return { ok: false, status: 404, error: 'Booking not found' };
    if (booking.guest_id !== userId) {
      return { ok: false, status: 403, error: 'Booking does not belong to this account' };
    }
    return validateChargeAmount(booking.total, { ride: null });
  }

  const listingId = Number(booking_listing_id);
  if (!listingId || Number.isNaN(listingId)) {
    return {
      ok: false,
      status: 400,
      error: 'Booking payments require booking_id or booking_listing_id with start_date',
    };
  }
  if (!start_date) {
    return { ok: false, status: 400, error: 'start_date is required to quote a booking payment' };
  }

  const listing = await prisma.booking_listing.findUnique({ where: { booking_listing_id: listingId } });
  if (!listing || !listing.is_active) {
    return { ok: false, status: 404, error: 'Listing not available' };
  }
  if (listing.owner_id === userId) {
    return { ok: false, status: 400, error: 'You cannot book your own listing' };
  }

  const qty = quantity != null ? Number(quantity) : 1;
  const guestCount = guests != null ? Number(guests) : 1;
  const partyError = validatePartySize(listing, guestCount);
  if (partyError) return { ok: false, status: 400, error: partyError };

  const u = computeUnits(listing.price_unit, {
    startDate: start_date,
    endDate: end_date,
    startTime: start_time,
    endTime: end_time,
    vertical: listing.vertical,
  });
  if (u.error) return { ok: false, status: 400, error: u.error };

  const quote = computeQuote(listing, u.units, { quantity: Number.isInteger(qty) && qty > 0 ? qty : 1 });
  return validateChargeAmount(quote.total, { ride: null });
}

/** Encode creator + amount into PayPal custom_id for capture binding (#1286). */
export function paypalCustomId(userId, amount) {
  return `u:${userId}|a:${Number(amount).toFixed(2)}`;
}

export function parsePaypalCustomId(customId) {
  const m = String(customId || '').match(/^u:(\d+)\|a:(\d+(?:\.\d{1,2})?)$/);
  if (!m) return null;
  return { userId: Number(m[1]), amount: Number(m[2]) };
}

router.post('/stripe/create-intent', authenticateToken, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });

    const userId = req.user.user_id;
    const {
      amount,
      currency = 'cad',
      ride_request_id,
      idempotency_key,
      purpose,
      vertical,
      items,
      tip,
      shipping_mode,
      item_source,
      seller_id,
      shipping_country,
      shipping_address,
      shipping_city,
      shipping_lat,
      shipping_lng,
      promo_code,
      booking_id,
      booking_listing_id,
      start_date,
      end_date,
      guests,
      quantity,
      start_time,
      end_time,
    } = req.body;

    let ride = null;
    if (ride_request_id != null) {
      const loaded = await loadRideAwaitingPayment(ride_request_id, userId);
      if (loaded.error) return res.status(loaded.status).json({ error: loaded.error });
      ride = loaded.ride;
    } else if (purpose === 'rideshare') {
      return res.status(400).json({ error: 'ride_request_id is required for rideshare payments' });
    }

    const validated = await resolvePaymentChargeAmount({
      userId,
      amount,
      ride,
      purpose,
      vertical,
      items,
      tip,
      shipping_mode,
      item_source,
      seller_id,
      shipping_country,
      shipping_address,
      shipping_city,
      shipping_lat,
      shipping_lng,
      promo_code,
      booking_id,
      booking_listing_id,
      start_date,
      end_date,
      guests,
      quantity,
      start_time,
      end_time,
    });
    if (!validated.ok) return res.status(validated.status).json({ error: validated.error });

    const idempotencyKey = buildStripeIdempotencyKey({
      rideRequestId: ride?.ride_request_id ?? ride_request_id,
      clientKey: idempotency_key,
    });

    // Tag every charge with who/what it's for. The platform webhook
    // (/booking/webhook/stripe) reads `purpose` to reconcile the charge to its
    // order/donation row, and records an orphan if no row is found. Rideshare keeps
    // its existing metadata shape; commerce/donation flows pass purpose + vertical.
    const createParams = {
      amount: Math.round(validated.amount * 100),
      currency,
      metadata: {
        user_id: String(userId),
        ...(ride
          ? { ride_request_id: String(ride.ride_request_id), purpose: 'rideshare' }
          : {
              ...(purpose ? { purpose: String(purpose) } : {}),
              ...(vertical ? { vertical: String(vertical) } : {}),
            }),
      },
    };

    const intent = idempotencyKey
      ? await stripe.paymentIntents.create(createParams, { idempotencyKey })
      : await stripe.paymentIntents.create(createParams);

    res.json({
      clientSecret: intent.client_secret,
      paymentIntentId: intent.id,
      // Server-authoritative amount actually being charged, so the caller can compare it
      // against whatever total it displayed to the user before this call and disclose a
      // "price changed, confirm to continue" step instead of silently charging a different
      // number than what was shown (project_lock_price_disclose_change).
      amount: validated.amount,
    });
  } catch (err) {
    console.error('Stripe create-intent error:', err.message);
    res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

router.post('/paypal/create-order', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const {
      amount,
      ride_request_id,
      purpose,
      vertical,
      items,
      tip,
      shipping_mode,
      item_source,
      seller_id,
      shipping_country,
      shipping_address,
      shipping_city,
      shipping_lat,
      shipping_lng,
      promo_code,
      booking_id,
      booking_listing_id,
      start_date,
      end_date,
      guests,
      quantity,
      start_time,
      end_time,
    } = req.body;

    // Rideshare PayPal is disabled until server-side capture verification + refund exist.
    // Block at order creation so the rider never captures a payment we can't reconcile.
    // (Other verticals' PayPal flows are unaffected.)
    if (ride_request_id != null || purpose === 'rideshare') {
      return res.status(503).json({ error: 'PayPal is temporarily unavailable for rideshare. Please pay by card or wallet.' });
    }

    const validated = await resolvePaymentChargeAmount({
      userId,
      amount,
      ride: null,
      purpose,
      vertical,
      items,
      tip,
      shipping_mode,
      item_source,
      seller_id,
      shipping_country,
      shipping_address,
      shipping_city,
      shipping_lat,
      shipping_lng,
      promo_code,
      booking_id,
      booking_listing_id,
      start_date,
      end_date,
      guests,
      quantity,
      start_time,
      end_time,
    });
    if (!validated.ok) return res.status(validated.status).json({ error: validated.error });

    const client = getPayPalClient();
    const request = new paypal.orders.OrdersCreateRequest();
    request.requestBody({
      intent: 'CAPTURE',
      purchase_units: [{
        amount: { currency_code: 'CAD', value: validated.amount.toFixed(2) },
        // Bind capture to creator + amount (#1286). Verified on /paypal/capture-order.
        custom_id: paypalCustomId(userId, validated.amount),
      }],
    });
    const order = await client.execute(request);
    // Same disclosure rationale as /stripe/create-intent — return the amount actually
    // placed on the PayPal order so the caller can flag a mismatch before capture.
    res.json({ id: order.result.id, amount: validated.amount });
  } catch (err) {
    console.error('PayPal create-order error:', err.message);
    res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

router.post('/paypal/capture-order', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const { orderID, booking_id } = req.body;

    if (!orderID) return res.status(400).json({ error: 'Missing orderID' });

    const client = getPayPalClient();
    const getReq = new paypal.orders.OrdersGetRequest(orderID);
    const existing = await client.execute(getReq);
    const unit = existing.result?.purchase_units?.[0];
    const bound = parsePaypalCustomId(unit?.custom_id);
    if (!bound || bound.userId !== userId) {
      return res.status(403).json({ error: 'PayPal order is not bound to this account' });
    }
    const orderValue = Number(unit?.amount?.value);
    if (!Number.isFinite(orderValue) || Math.round(orderValue * 100) !== Math.round(bound.amount * 100)) {
      return res.status(400).json({ error: 'PayPal order amount mismatch' });
    }

    const request = new paypal.orders.OrdersCaptureRequest(orderID);
    request.requestBody({});
    const capture = await client.execute(request);
    const status = String(capture.result?.status || '').toUpperCase();
    const bookingId = Number(booking_id);
    if (status === 'COMPLETED' && Number.isInteger(bookingId) && bookingId > 0) {
      try {
        await prisma.booking.updateMany({
          where: {
            booking_id: bookingId,
            guest_id: req.user.user_id,
            payment_status: { not: 'paid' },
            status: { in: ['requested', 'awaiting_host', 'confirmed'] },
          },
          data: {
            payment_status: 'paid',
            payment_method: 'paypal',
            payment_intent_id: String(orderID),
          },
        });
      } catch (err) {
        console.error('[paypal] booking mark-paid failed:', err.message);
      }
    }
    res.json(capture.result);
  } catch (err) {
    console.error('PayPal capture-order error:', err.message);
    res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

// Find or create a Stripe customer for a user (keyed by email, no DB migration needed)
async function getOrCreateStripeCustomer(userId) {
  if (!stripe) throw new Error('Stripe not configured');
  const user = await prisma.user.findUnique({ where: { user_id: userId }, select: { email: true, name: true } });
  if (!user?.email) throw new Error('User email required');
  const email = decrypt(user.email);
  const existing = await stripe.customers.search({ query: `email:"${email}"`, limit: 1 });
  if (existing.data.length > 0) return existing.data[0];
  return stripe.customers.create({ email, name: user.name ?? undefined });
}

// POST /payments/setup-intent — creates a Stripe SetupIntent for saving a payment method
router.post('/setup-intent', authenticateToken, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
    const customer = await getOrCreateStripeCustomer(req.user.user_id);
    const intent = await stripe.setupIntents.create({ customer: customer.id, payment_method_types: ['card'] });
    res.json({ clientSecret: intent.client_secret });
  } catch (err) {
    console.error('setup-intent error:', err.message);
    res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

// GET /payments/payment-methods — lists saved cards for the authenticated user
router.get('/payment-methods', authenticateToken, async (req, res) => {
  try {
    if (!stripe) return res.json([]);
    const user = await prisma.user.findUnique({ where: { user_id: req.user.user_id }, select: { email: true } });
    if (!user?.email) return res.json([]);
    const customers = await stripe.customers.search({ query: `email:"${decrypt(user.email)}"`, limit: 1 });
    if (!customers.data.length) return res.json([]);
    const methods = await stripe.paymentMethods.list({ customer: customers.data[0].id, type: 'card' });
    const cards = methods.data.map(m => ({
      id: m.id,
      brand: m.card?.brand ?? 'card',
      last4: m.card?.last4 ?? '????',
      exp_month: m.card?.exp_month,
      exp_year: m.card?.exp_year,
    }));
    res.json(cards);
  } catch (err) {
    console.error('payment-methods error:', err.message);
    res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

// DELETE /payments/payment-methods/:id — detach a saved card
router.delete('/payment-methods/:id', authenticateToken, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ successful: false, message: 'Stripe not configured' });
    await stripe.paymentMethods.detach(req.params.id);
    res.json({ successful: true });
  } catch (err) {
    console.error('remove-payment-method error:', err.message);
    res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

export const __test = {
  detectCartSource,
  resolvePaymentChargeAmount,
  paypalCustomId,
  parsePaypalCustomId,
  CLIENT_AMOUNT_PURPOSES,
};

export default router;
