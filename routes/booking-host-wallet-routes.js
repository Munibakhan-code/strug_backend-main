import express from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma-client.js';
import { authenticateToken, requireAdmin } from '../middleware/authentication.js';
import { round2 } from '../utils/analytics-buckets.js';
import { parseBookingVertical } from '../utils/booking-vertical.js';
import {
  getStripe,
  PAYOUT_CURRENCY,
  ensureBookingHostWallet,
  pendingBalanceForHost,
  reconcileBookingHostWallet,
  bookingHostLedgerRefs,
  PAYOUT_HOLD_REF,
  createBookingHostOnboardingLink,
  bookingHostConnectStatus,
  approveBookingHostPayout,
  markBookingHostPaid,
  rejectBookingHostPayout,
} from '../services/booking-host-payout.js';

const router = express.Router();

const PAYOUT_STATUSES = new Set(['PENDING', 'APPROVED', 'REJECTED', 'PAID']);

const payoutSchema = z.object({
  amount: z.coerce.number().positive().min(100).transform((n) => round2(n)),
});

const HOST_CONNECT_PATHS = new Set([
  '/provider/host',
  '/provider/hotel',
  '/provider/vehicle',
  '/provider/venue',
  '/provider/venues',
  '/provider/equipment',
  '/provider/events',
]);

function connectBaseUrl() {
  return (process.env.FRONTEND_URL || 'https://app.strug.ca').replace(/\/$/, '');
}

function safeReturnPath(raw) {
  const path = typeof raw === 'string' ? raw.trim().replace(/\/$/, '') : '';
  if (HOST_CONNECT_PATHS.has(path)) return path;
  return '/provider/hotel';
}

function verticalFromQuery(req) {
  const parsed = parseBookingVertical(req.query.vertical);
  if (!parsed.ok) return { error: parsed.error };
  return { vertical: parsed.vertical };
}

function parsePayoutId(req, res) {
  const payoutId = Number(req.params.payout_id);
  if (!Number.isInteger(payoutId) || payoutId <= 0) {
    res.status(400).json({ successful: false, message: 'Invalid payout id.' });
    return null;
  }
  return payoutId;
}

async function loadHostPayout(payoutId) {
  return prisma.booking_host_payout_request.findUnique({
    where: { payout_id: payoutId },
    include: {
      user: { select: { user_id: true, email: true, name: true } },
    },
  });
}

router.get('/host/me/wallet', authenticateToken, async (req, res, next) => {
  try {
    const scope = verticalFromQuery(req);
    if (scope.error) return res.status(400).json({ successful: false, message: scope.error });
    const user_id = req.user.user_id;
    await reconcileBookingHostWallet(user_id, { vertical: scope.vertical });
    const wallet = await ensureBookingHostWallet(prisma, user_id);
    const pending_balance = round2(await pendingBalanceForHost(user_id, { vertical: scope.vertical }));
    return res.json({
      successful: true,
      available_balance: round2(Number(wallet.available_balance)),
      pending_balance,
      total_earned: round2(Number(wallet.total_earned)),
      currency: wallet.currency || PAYOUT_CURRENCY,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/host/me/wallet/transactions', authenticateToken, async (req, res, next) => {
  try {
    const scope = verticalFromQuery(req);
    if (scope.error) return res.status(400).json({ successful: false, message: scope.error });
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 50;
    const refs = await bookingHostLedgerRefs(req.user.user_id, { vertical: scope.vertical });
    if (refs.length === 0) return res.json({ successful: true, data: [] });
    const rows = await prisma.wallet_transaction.findMany({
      where: {
        user_id: req.user.user_id,
        external_ref: { in: refs },
      },
      orderBy: { created_at: 'desc' },
      take: limit,
    });
    return res.json({ successful: true, data: rows });
  } catch (err) {
    next(err);
  }
});

router.get('/host/me/wallet/payouts', authenticateToken, async (req, res, next) => {
  try {
    const requests = await prisma.booking_host_payout_request.findMany({
      where: { user_id: req.user.user_id },
      orderBy: { created_at: 'desc' },
    });
    return res.json({ successful: true, data: requests });
  } catch (err) {
    next(err);
  }
});

router.post('/host/me/wallet/payout-request', authenticateToken, async (req, res, next) => {
  try {
    const validated = payoutSchema.parse(req.body);
    const user_id = req.user.user_id;
    const wallet = await ensureBookingHostWallet(prisma, user_id);

    if (Number(wallet.available_balance) < validated.amount) {
      return res.status(400).json({ successful: false, message: 'Insufficient_Balance' });
    }

    let request;
    try {
      request = await prisma.$transaction(async (tx) => {
        const debit = await tx.booking_host_wallet.updateMany({
          where: {
            wallet_id: wallet.wallet_id,
            available_balance: { gte: validated.amount },
          },
          data: { available_balance: { decrement: validated.amount } },
        });
        if (debit.count !== 1) {
          const e = new Error('Insufficient_Balance');
          e.code = 'INSUFFICIENT_BALANCE';
          throw e;
        }
        const created = await tx.booking_host_payout_request.create({
          data: {
            user_id,
            amount: validated.amount,
          },
        });
        await tx.wallet_transaction.create({
          data: {
            user_id,
            amount: validated.amount,
            type: 'debit',
            source: 'booking_payout_hold',
            description: `Hold for booking payout #${created.payout_id}`,
            external_ref: PAYOUT_HOLD_REF(created.payout_id),
          },
        });
        return created;
      });
    } catch (e) {
      if (e.code === 'INSUFFICIENT_BALANCE' || e.message === 'Insufficient_Balance') {
        return res.status(400).json({ successful: false, message: 'Insufficient_Balance' });
      }
      throw e;
    }

    return res.status(201).json({ successful: true, data: request });
  } catch (err) {
    if (err?.name === 'ZodError') {
      return res.status(400).json({ successful: false, message: 'Invalid_Amount' });
    }
    next(err);
  }
});

router.post('/host/me/wallet/connect/onboard', authenticateToken, async (req, res, next) => {
  try {
    if (!getStripe()) return res.status(503).json({ successful: false, message: 'Stripe not configured' });
    const base = connectBaseUrl();
    const returnPath = safeReturnPath(req.body?.return_path);
    const result = await createBookingHostOnboardingLink(req.user.user_id, {
      refreshUrl: `${base}${returnPath}?connect=refresh`,
      returnUrl: `${base}${returnPath}?connect=done`,
    });
    return res.json({ successful: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.get('/host/me/wallet/connect/status', authenticateToken, async (req, res, next) => {
  try {
    const status = await bookingHostConnectStatus(req.user.user_id);
    return res.json({ successful: true, ...status });
  } catch (err) {
    next(err);
  }
});

router.get('/host/admin/payouts', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const { status } = req.query;
    if (status && !PAYOUT_STATUSES.has(String(status))) {
      return res.status(400).json({ successful: false, message: 'Invalid_Status' });
    }
    const where = status
      ? { status }
      : { status: { in: ['PENDING', 'APPROVED'] } };
    const payouts = await prisma.booking_host_payout_request.findMany({
      where,
      orderBy: { created_at: 'asc' },
      include: {
        user: { select: { user_id: true, email: true, name: true } },
      },
    });
    return res.json({ successful: true, data: payouts });
  } catch (err) {
    next(err);
  }
});

router.post('/host/admin/payouts/:payout_id/approve', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const payoutId = parsePayoutId(req, res);
    if (payoutId === null) return;
    const payout = await loadHostPayout(payoutId);
    if (!payout) return res.status(404).json({ successful: false, message: 'Payout_Not_Found' });
    const updated = await approveBookingHostPayout(payout, { note: req.body?.note });
    return res.json({ successful: true, data: updated });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ successful: false, message: err.message });
    next(err);
  }
});

router.post('/host/admin/payouts/:payout_id/mark-paid', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const payoutId = parsePayoutId(req, res);
    if (payoutId === null) return;
    const payout = await loadHostPayout(payoutId);
    if (!payout) return res.status(404).json({ successful: false, message: 'Payout_Not_Found' });
    const updated = await markBookingHostPaid(payout, { reference: req.body?.reference });
    return res.json({ successful: true, data: updated });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ successful: false, message: err.message });
    next(err);
  }
});

router.post('/host/admin/payouts/:payout_id/reject', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const payoutId = parsePayoutId(req, res);
    if (payoutId === null) return;
    const payout = await loadHostPayout(payoutId);
    if (!payout) return res.status(404).json({ successful: false, message: 'Payout_Not_Found' });
    const updated = await rejectBookingHostPayout(payout, { note: req.body?.note });
    return res.json({ successful: true, data: updated });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ successful: false, message: err.message });
    next(err);
  }
});

export default router;
