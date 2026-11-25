import express from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma-client.js';
import { authenticateToken, requireAdmin } from '../middleware/authentication.js';
import { isFoodVendor } from '../middleware/food-vendor-check.js';
import { round2 } from '../utils/analytics-buckets.js';
import {
  getStripe,
  PAYOUT_CURRENCY,
  ensureFoodVendorWallet,
  pendingBalanceForVendor,
  reconcileFoodVendorWallet,
  foodVendorLedgerRefs,
  PAYOUT_HOLD_REF,
  createFoodOnboardingLink,
  foodConnectStatus,
  approveFoodPayout,
  markFoodPaid,
  rejectFoodPayout,
} from '../services/food-payout.js';

const router = express.Router();

const PAYOUT_STATUSES = new Set(['PENDING', 'APPROVED', 'REJECTED', 'PAID']);

const payoutSchema = z.object({
  amount: z.coerce.number().positive().min(100).transform((n) => round2(n)),
});

const FOOD_CONNECT_PATHS = new Set([
  '/provider/food',
  '/provider/flowers',
  '/provider/groceries',
  '/provider/catering',
  '/provider/restbookings',
  '/provider/mealkit',
]);

function connectBaseUrl() {
  return (process.env.FRONTEND_URL || 'https://app.strug.ca').replace(/\/$/, '');
}

function safeReturnPath(raw) {
  const path = typeof raw === 'string' ? raw.trim().replace(/\/$/, '') : '';
  if (FOOD_CONNECT_PATHS.has(path)) return path;
  return '/provider/restbookings';
}

function parsePayoutId(req, res) {
  const payoutId = Number(req.params.payout_id);
  if (!Number.isInteger(payoutId) || payoutId <= 0) {
    res.status(400).json({ successful: false, message: 'Invalid payout id.' });
    return null;
  }
  return payoutId;
}

async function loadFoodPayout(payoutId) {
  return prisma.food_vendor_payout_request.findUnique({
    where: { payout_id: payoutId },
    include: {
      vendor: {
        select: {
          vendor_id: true,
          owner_id: true,
          vendor_name: true,
          stripe_account_id: true,
        },
      },
    },
  });
}

router.get('/vendor/me/wallet', authenticateToken, isFoodVendor, async (req, res, next) => {
  try {
    const vendor = req.foodVendor;
    if (vendor.owner_id == null) {
      return res.status(400).json({ successful: false, message: 'Wallet_Owner_Required' });
    }
    await reconcileFoodVendorWallet(vendor.vendor_id);
    const wallet = await ensureFoodVendorWallet(prisma, {
      vendor_id: vendor.vendor_id,
      user_id: vendor.owner_id,
    });
    const pending_balance = round2(await pendingBalanceForVendor(vendor.vendor_id));
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

router.get('/vendor/me/wallet/transactions', authenticateToken, isFoodVendor, async (req, res, next) => {
  try {
    const vendor = req.foodVendor;
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 50;
    const refs = await foodVendorLedgerRefs(vendor.vendor_id);
    if (refs.length === 0) return res.json({ successful: true, data: [] });
    const rows = await prisma.wallet_transaction.findMany({
      where: {
        user_id: vendor.owner_id,
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

router.get('/vendor/me/wallet/payouts', authenticateToken, isFoodVendor, async (req, res, next) => {
  try {
    const requests = await prisma.food_vendor_payout_request.findMany({
      where: { vendor_id: req.foodVendor.vendor_id },
      orderBy: { created_at: 'desc' },
    });
    return res.json({ successful: true, data: requests });
  } catch (err) {
    next(err);
  }
});

router.post('/vendor/me/wallet/payout-request', authenticateToken, isFoodVendor, async (req, res, next) => {
  try {
    const validated = payoutSchema.parse(req.body);
    const vendor = req.foodVendor;
    if (vendor.owner_id == null) {
      return res.status(400).json({ successful: false, message: 'Wallet_Owner_Required' });
    }
    const wallet = await ensureFoodVendorWallet(prisma, {
      vendor_id: vendor.vendor_id,
      user_id: vendor.owner_id,
    });

    if (Number(wallet.available_balance) < validated.amount) {
      return res.status(400).json({ successful: false, message: 'Insufficient_Balance' });
    }

    let request;
    try {
      request = await prisma.$transaction(async (tx) => {
        const debit = await tx.food_vendor_wallet.updateMany({
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
        const created = await tx.food_vendor_payout_request.create({
          data: {
            vendor_id: vendor.vendor_id,
            amount: validated.amount,
          },
        });
        await tx.wallet_transaction.create({
          data: {
            user_id: vendor.owner_id,
            amount: validated.amount,
            type: 'debit',
            source: 'food_payout_hold',
            description: `Hold for food payout #${created.payout_id}`,
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

router.post('/vendor/me/wallet/connect/onboard', authenticateToken, isFoodVendor, async (req, res, next) => {
  try {
    if (!getStripe()) return res.status(503).json({ successful: false, message: 'Stripe not configured' });
    const base = connectBaseUrl();
    const returnPath = safeReturnPath(req.body?.return_path);
    const result = await createFoodOnboardingLink(req.foodVendor, {
      refreshUrl: `${base}${returnPath}?connect=refresh`,
      returnUrl: `${base}${returnPath}?connect=done`,
    });
    return res.json({ successful: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.get('/vendor/me/wallet/connect/status', authenticateToken, isFoodVendor, async (req, res, next) => {
  try {
    const status = await foodConnectStatus(req.foodVendor);
    return res.json({ successful: true, ...status });
  } catch (err) {
    next(err);
  }
});

router.get('/vendor/admin/payouts', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const { status } = req.query;
    if (status && !PAYOUT_STATUSES.has(String(status))) {
      return res.status(400).json({ successful: false, message: 'Invalid_Status' });
    }
    const where = status
      ? { status }
      : { status: { in: ['PENDING', 'APPROVED'] } };
    const payouts = await prisma.food_vendor_payout_request.findMany({
      where,
      orderBy: { created_at: 'asc' },
      include: {
        vendor: {
          select: {
            vendor_id: true,
            vendor_name: true,
            stripe_account_id: true,
            owner_id: true,
          },
        },
      },
    });
    return res.json({ successful: true, data: payouts });
  } catch (err) {
    next(err);
  }
});

router.post('/vendor/admin/payouts/:payout_id/approve', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const payoutId = parsePayoutId(req, res);
    if (payoutId === null) return;
    const payout = await loadFoodPayout(payoutId);
    if (!payout) return res.status(404).json({ successful: false, message: 'Payout_Not_Found' });
    const updated = await approveFoodPayout(payout, { note: req.body?.note });
    return res.json({ successful: true, data: updated });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ successful: false, message: err.message });
    next(err);
  }
});

router.post('/vendor/admin/payouts/:payout_id/mark-paid', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const payoutId = parsePayoutId(req, res);
    if (payoutId === null) return;
    const payout = await loadFoodPayout(payoutId);
    if (!payout) return res.status(404).json({ successful: false, message: 'Payout_Not_Found' });
    const updated = await markFoodPaid(payout, { reference: req.body?.reference });
    return res.json({ successful: true, data: updated });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ successful: false, message: err.message });
    next(err);
  }
});

router.post('/vendor/admin/payouts/:payout_id/reject', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const payoutId = parsePayoutId(req, res);
    if (payoutId === null) return;
    const payout = await loadFoodPayout(payoutId);
    if (!payout) return res.status(404).json({ successful: false, message: 'Payout_Not_Found' });
    const updated = await rejectFoodPayout(payout, { note: req.body?.note });
    return res.json({ successful: true, data: updated });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ successful: false, message: err.message });
    next(err);
  }
});

export default router;
