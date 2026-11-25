import express from 'express';
import Stripe from 'stripe';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { requireAuthUserId, assertPassengerOwnsTrip } from '../utils/ride-auth.js';
import { creditDriverTip } from '../utils/ride-settlement.js';

const router = express.Router();
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const MIN_TIP = 1;
const MAX_TIP = 100;

async function loadCompletedTripOwnedByRider(tripId, userId) {
  const trip = await prisma.active_trip.findUnique({
    where: { trip_id: tripId },
    include: { ride_request: true, driver_profile: true },
  });
  if (!trip || !trip.ended_at) {
    return { error: { status: 400, message: 'Trip must be completed before tipping' } };
  }
  if (trip.ride_request?.status !== 'completed') {
    return { error: { status: 400, message: 'Ride must be completed before tipping' } };
  }
  const denied = await assertPassengerOwnsTrip(prisma, trip, userId);
  if (denied) return { error: denied };
  return { trip };
}

// POST /ride-tip/:trip_id/create-intent — a fresh Stripe charge for the tip, separate from
// the fare's own PaymentIntent (already captured by the time a trip can be tipped). Tips are
// charged directly to the rider's card, not debited from a wallet — most riders have never
// funded a strug_wallet, so requiring a pre-funded balance here would block most tips.
router.post('/:trip_id/create-intent', authenticateToken, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ successful: false, message: 'Card payments are not configured.' });
    const userId = requireAuthUserId(req, res);
    if (!userId) return;
    const tripId = Number(req.params.trip_id);
    if (!Number.isInteger(tripId)) return res.status(400).json({ successful: false, message: 'Invalid trip id' });

    const amount = Number(req.body?.amount);
    if (!(amount >= MIN_TIP && amount <= MAX_TIP)) {
      return res.status(400).json({ successful: false, message: `Tip must be between $${MIN_TIP} and $${MAX_TIP}.` });
    }

    const { trip, error } = await loadCompletedTripOwnedByRider(tripId, userId);
    if (error) return res.status(error.status).json({ successful: false, message: error.message });
    if (Number(trip.tip_amount) > 0) {
      return res.status(409).json({ successful: false, message: 'A tip has already been added for this trip.' });
    }

    const intent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: 'cad',
      metadata: { user_id: String(userId), trip_id: String(tripId), purpose: 'rideshare_tip' },
    }, { idempotencyKey: `rideshare-tip-${tripId}` });

    res.json({ successful: true, clientSecret: intent.client_secret, paymentIntentId: intent.id });
  } catch (err) {
    console.error('Ride tip create-intent error:', err.message);
    res.status(500).json({ successful: false, message: 'Failed to start tip payment' });
  }
});

// POST /ride-tip/:trip_id/confirm — after the client confirms the card, verify the
// PaymentIntent succeeded server-side (never trust the client) and credit the driver's wallet
// 100% of the tip, exactly once (idempotent on the PaymentIntent id via
// wallet_transaction.external_ref's UNIQUE constraint — mirrors routes/work-wallet-routes.js).
router.post('/:trip_id/confirm', authenticateToken, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ successful: false, message: 'Card payments are not configured.' });
    const userId = requireAuthUserId(req, res);
    if (!userId) return;
    const tripId = Number(req.params.trip_id);
    if (!Number.isInteger(tripId)) return res.status(400).json({ successful: false, message: 'Invalid trip id' });

    const piId = String(req.body?.payment_intent_id || '');
    if (!piId) return res.status(400).json({ successful: false, message: 'payment_intent_id is required' });

    const pi = await stripe.paymentIntents.retrieve(piId);
    if (!pi || pi.status !== 'succeeded') {
      return res.status(409).json({ successful: false, message: 'Payment has not succeeded yet.' });
    }
    if (
      pi.metadata?.purpose !== 'rideshare_tip'
      || pi.metadata?.user_id !== String(userId)
      || pi.metadata?.trip_id !== String(tripId)
    ) {
      return res.status(403).json({ successful: false, message: 'This payment is not a tip for your trip.' });
    }

    const { trip, error } = await loadCompletedTripOwnedByRider(tripId, userId);
    if (error) return res.status(error.status).json({ successful: false, message: error.message });

    const already = await prisma.wallet_transaction.findFirst({ where: { external_ref: piId } });
    if (already) {
      return res.json({ successful: true, credited: false, alreadyApplied: true, tip_amount: Number(trip.tip_amount) || 0 });
    }

    const driverUserId = trip.driver_profile?.user_id ?? null;
    const tipAmount = pi.amount_received / 100;

    try {
      await prisma.$transaction(async (tx) => {
        await creditDriverTip(tx, { tripId, driverUserId, tipAmount, paymentIntentId: piId });
        await tx.active_trip.update({
          where: { trip_id: tripId },
          data: { tip_amount: { increment: tipAmount } },
        });
      });
    } catch (creditErr) {
      if (creditErr?.code === 'P2002') {
        return res.json({ successful: true, credited: false, alreadyApplied: true });
      }
      throw creditErr;
    }

    res.json({ successful: true, credited: true, tip_amount: tipAmount });
  } catch (err) {
    console.error('Ride tip confirm error:', err.message);
    res.status(500).json({ successful: false, message: 'Failed to confirm tip' });
  }
});

export default router;
