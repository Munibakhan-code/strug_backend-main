import express from 'express';
import Stripe from 'stripe';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { creditWorkWallet } from '../utils/work-wallet.js';

const router = express.Router();
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const MIN_TOPUP = 1;
const MAX_TOPUP = 2000;

// GET /work-wallet/balance — the user's core strug_wallet balance.
router.get('/balance', authenticateToken, async (req, res) => {
  try {
    let wallet = await prisma.strug_wallet.findUnique({ where: { user_id: req.user.user_id } });
    if (!wallet) wallet = await prisma.strug_wallet.create({ data: { user_id: req.user.user_id, balance: 0, currency: 'CAD' } });
    res.json({ balance: parseFloat(wallet.balance), currency: wallet.currency });
  } catch (e) { console.error(e); res.status(500).json({ message: 'Failed to fetch balance' }); }
});

// POST /work-wallet/topup — create a Stripe PaymentIntent to add funds to the wallet.
// Returns the clientSecret for the frontend to confirm with a card.
router.post('/topup', authenticateToken, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'stripe_unavailable', message: 'Card payments are not configured.' });
    const amount = Number(req.body?.amount);
    if (!(amount >= MIN_TOPUP && amount <= MAX_TOPUP)) {
      return res.status(400).json({ message: `Top-up amount must be between $${MIN_TOPUP} and $${MAX_TOPUP}.` });
    }
    // Minimal params mirroring the known-working rideshare create-intent — confirmed
    // client-side via stripe.confirmCardPayment.
    const intent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: 'cad',
      metadata: { user_id: String(req.user.user_id), purpose: 'wallet_topup' },
    });
    res.json({ clientSecret: intent.client_secret, paymentIntentId: intent.id });
  } catch (e) { console.error('topup create error:', e.message); res.status(500).json({ message: 'Failed to start top-up' }); }
});

// POST /work-wallet/topup/confirm — after the client confirms the card, the server
// verifies the PaymentIntent succeeded (trusting Stripe, not the client) and credits the
// wallet exactly once (idempotent on the PaymentIntent id).
router.post('/topup/confirm', authenticateToken, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'stripe_unavailable' });
    const piId = String(req.body?.payment_intent_id || '');
    if (!piId) return res.status(400).json({ message: 'payment_intent_id is required' });

    const pi = await stripe.paymentIntents.retrieve(piId);
    if (!pi || pi.status !== 'succeeded') return res.status(409).json({ message: 'Payment has not succeeded yet.' });
    if (pi.metadata?.purpose !== 'wallet_topup' || pi.metadata?.user_id !== String(req.user.user_id)) {
      return res.status(403).json({ message: 'This payment is not a wallet top-up for your account.' });
    }
    // Idempotency: credit at most once per PaymentIntent. The wallet_transaction.external_ref
    // UNIQUE constraint is the real guard — a fast-path findFirst short-circuits the common
    // case, but the constraint is what makes concurrent confirms safe (the old findFirst-only
    // check had a TOCTOU window where two requests both missed and both credited).
    const already = await prisma.wallet_transaction.findFirst({ where: { external_ref: piId } });
    if (already) {
      const w = await prisma.strug_wallet.findUnique({ where: { user_id: req.user.user_id } });
      return res.json({ credited: false, alreadyApplied: true, balance: w ? parseFloat(w.balance) : 0 });
    }
    const amount = pi.amount_received / 100;
    try {
      await creditWorkWallet(req.user.user_id, amount, 'wallet_topup', `Wallet top-up via card (${piId})`, piId);
    } catch (creditErr) {
      // P2002 = a concurrent confirm already credited this PaymentIntent — treat as applied.
      if (creditErr?.code === 'P2002') {
        const w = await prisma.strug_wallet.findUnique({ where: { user_id: req.user.user_id } });
        return res.json({ credited: false, alreadyApplied: true, balance: w ? parseFloat(w.balance) : 0 });
      }
      throw creditErr;
    }
    const w = await prisma.strug_wallet.findUnique({ where: { user_id: req.user.user_id } });
    res.json({ credited: true, amount, balance: w ? parseFloat(w.balance) : 0 });
  } catch (e) { console.error('topup confirm error:', e.message); res.status(500).json({ message: 'Failed to confirm top-up' }); }
});

export default router;
