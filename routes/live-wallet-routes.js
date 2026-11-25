import express from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma-client.js';
import { authenticateToken, requireAdmin } from '../middleware/authentication.js';
import {
    getStripe,
    createOnboardingLink,
    connectStatus,
    approvePayout,
    markPaid,
    rejectPayout,
} from '../services/live-payout.js';

const router = express.Router();

const payoutSchema = z.object({
    amount: z.number().positive().min(100)
});

// LNEW-1: this endpoint mutates streamer wallet balances and is meant to be called only
// by the internal ad-settlement job — never by a browser client. Gate it on a shared
// secret and FAIL CLOSED (reject if no secret is configured) so it can never be reached
// anonymously over the public internet.
function requireInternalSecret(req, res, next) {
    const expected = process.env.INTERNAL_JOB_SECRET || process.env.LIVE_HOOK_SECRET;
    const provided = req.get('x-internal-secret');
    if (!expected || !provided || provided !== expected) {
        return res.status(401).json({ successful: false, message: "Unauthorized" });
    }
    next();
}

router.get('/balance', authenticateToken, async (req, res, next) => {
    try {
        const wallet = await prisma.live_streamer_wallet.findUnique({
            where: { user_id: req.user.user_id },
            include: { streamer: { select: { monetization_status: true } } }
        });

        if (!wallet) return res.status(404).json({ message: "Wallet_Not_Found" });

        return res.json({ 
            successful: true, 
            balance: wallet.balance, 
            currency: wallet.currency,
            status: wallet.streamer.monetization_status
        });
    } catch (err) {
        next(err);
    }
});

router.post('/payout-request', authenticateToken, async (req, res, next) => {
    try {
        const validated = payoutSchema.parse(req.body);
        const user_id = req.user.user_id;

        const wallet = await prisma.live_streamer_wallet.findUnique({
            where: { user_id },
            include: { streamer: true }
        });

        if (!wallet || wallet.streamer.monetization_status !== 'APPROVED') {
            return res.status(403).json({ message: "Monetization_Not_Enabled" });
        }

        // Fast pre-check for a friendly 400; the authoritative check is the conditional
        // decrement inside the transaction (the pre-check alone is racy — two concurrent
        // requests both pass it on the same balance and both debit → negative balance).
        if (Number(wallet.balance) < validated.amount) {
            return res.status(400).json({ message: "Insufficient_Balance" });
        }

        let request;
        try {
            request = await prisma.$transaction(async (tx) => {
                // H10: conditional debit — only decrements while the balance still covers the
                // amount. count === 0 means a concurrent payout already spent it; abort.
                const debit = await tx.live_streamer_wallet.updateMany({
                    where: { wallet_id: wallet.wallet_id, balance: { gte: validated.amount } },
                    data: { balance: { decrement: validated.amount } }
                });
                if (debit.count !== 1) {
                    const e = new Error("Insufficient_Balance");
                    e.code = 'INSUFFICIENT_BALANCE';
                    throw e;
                }

                return await tx.live_payout_request.create({
                    data: {
                        streamer_id: wallet.streamer_id,
                        amount: validated.amount
                    }
                });
            });
        } catch (e) {
            if (e.code === 'INSUFFICIENT_BALANCE') {
                return res.status(400).json({ message: "Insufficient_Balance" });
            }
            throw e;
        }

        return res.status(201).json({ successful: true, data: request });
    } catch (err) {
        next(err);
    }
});

router.post('/internal/credit-ad-revenue', requireInternalSecret, async (req, res, next) => {
    try {
        const { streamer_id, total_revenue, idempotency_key } = req.body;
        const revenue = Number(total_revenue);
        const streamerIdNum = Number(streamer_id);

        if (!Number.isInteger(streamerIdNum) || streamerIdNum <= 0) {
            return res.status(400).json({ message: "Invalid streamer id." });
        }
        if (!Number.isFinite(revenue) || revenue < 0) {
            return res.status(400).json({ message: "Invalid revenue amount." });
        }
        // H9: an idempotency key is REQUIRED so an at-least-once retry of the settlement job
        // can't credit the same revenue twice. Identifies one settlement period uniquely.
        const idemKey = typeof idempotency_key === 'string' ? idempotency_key.trim().slice(0, 120) : '';
        if (!idemKey) {
            return res.status(400).json({ message: "Missing idempotency_key." });
        }
        const idemMarker = `[idem:${idemKey}]`;

        const streamer = await prisma.live_streamer_profile.findUnique({
            where: { streamer_id: streamerIdNum },
            include: { sub_wallet: true }
        });

        if (!streamer) return res.status(404).json({ message: "Streamer_Not_Found" });

        let streamerShare = 0;
        let platformShare = revenue;

        if (streamer.monetization_status === 'APPROVED') {
            streamerShare = revenue * 0.70;
            platformShare = revenue * 0.30;
        }

        let alreadyApplied = false;
        await prisma.$transaction(async (tx) => {
            // H9: skip if this settlement was already credited (keyed by the idempotency marker
            // on the platform-share ledger row). NOTE: a DB unique constraint on the key would
            // make this race-safe for concurrent (not just sequential) retries — follow-up.
            const existing = await tx.wallet_transaction.findFirst({
                where: { source: "live_ad_tax", description: { contains: idemMarker } },
                select: { transaction_id: true },
            });
            if (existing) { alreadyApplied = true; return; }

            if (streamerShare > 0) {
                await tx.live_streamer_wallet.update({
                    where: { streamer_id: streamer.streamer_id },
                    data: { balance: { increment: streamerShare } }
                });
            }

            await tx.wallet_transaction.create({
                data: {
                    user_id: 1,
                    amount: platformShare,
                    type: "credit",
                    source: "live_ad_tax",
                    description: `Platform share from Streamer ${streamer.handle} ${idemMarker}`
                }
            });
        });

        return res.json({ successful: true, idempotent: alreadyApplied, split: { streamer: streamerShare, platform: platformShare } });
    } catch (err) {
        next(err);
    }
});

// ── Stripe Connect onboarding (streamer-facing) ──────────────────────────────
// Lets an approved streamer connect an Express account so payouts can be
// transferred automatically. Optional: payouts still work manually without it.
router.post('/connect/onboard', authenticateToken, async (req, res, next) => {
    try {
        if (!getStripe()) return res.status(503).json({ successful: false, message: "Stripe not configured" });
        const streamer = await prisma.live_streamer_profile.findUnique({
            where: { user_id: req.user.user_id },
            select: { streamer_id: true, user_id: true, handle: true, stripe_account_id: true, monetization_status: true },
        });
        if (!streamer) return res.status(404).json({ successful: false, message: "Not_A_Streamer" });
        if (streamer.monetization_status !== 'APPROVED') {
            return res.status(403).json({ successful: false, message: "Monetization_Not_Enabled" });
        }

        const base = (process.env.FRONTEND_URL || 'https://app.strug.ca').replace(/\/$/, '');
        const result = await createOnboardingLink(streamer, {
            refreshUrl: `${base}/sd-streamer?connect=refresh`,
            returnUrl: `${base}/sd-streamer?connect=done`,
        });
        return res.json({ successful: true, ...result });
    } catch (err) {
        next(err);
    }
});

router.get('/connect/status', authenticateToken, async (req, res, next) => {
    try {
        const streamer = await prisma.live_streamer_profile.findUnique({
            where: { user_id: req.user.user_id },
            select: { streamer_id: true, stripe_account_id: true },
        });
        if (!streamer) return res.status(404).json({ successful: false, message: "Not_A_Streamer" });
        const status = await connectStatus(streamer);
        return res.json({ successful: true, ...status });
    } catch (err) {
        next(err);
    }
});

// ── Admin payout management ──────────────────────────────────────────────────
// List payout requests (default: the actionable PENDING/APPROVED queue).
router.get('/admin/payouts', authenticateToken, requireAdmin, async (req, res, next) => {
    try {
        const { status } = req.query;
        const where = status
            ? { status }
            : { status: { in: ['PENDING', 'APPROVED'] } };
        const payouts = await prisma.live_payout_request.findMany({
            where,
            orderBy: { created_at: 'asc' },
            include: {
                streamer: { select: { streamer_id: true, handle: true, display_name: true, stripe_account_id: true } },
            },
        });
        return res.json({ successful: true, data: payouts });
    } catch (err) {
        next(err);
    }
});

// Helper: load a payout (with the streamer needed for transfer/refund) or 404.
async function loadPayout(payoutId) {
    return prisma.live_payout_request.findUnique({
        where: { payout_id: payoutId },
        include: {
            streamer: { select: { streamer_id: true, user_id: true, handle: true, stripe_account_id: true } },
        },
    });
}

function parsePayoutId(req, res) {
    const payoutId = Number(req.params.payout_id);
    if (!Number.isInteger(payoutId) || payoutId <= 0) {
        res.status(400).json({ successful: false, message: "Invalid payout id." });
        return null;
    }
    return payoutId;
}

// Approve: auto-transfer via Connect if available, else clear for manual payout.
router.post('/admin/payouts/:payout_id/approve', authenticateToken, requireAdmin, async (req, res, next) => {
    try {
        const payoutId = parsePayoutId(req, res);
        if (payoutId === null) return;
        const payout = await loadPayout(payoutId);
        if (!payout) return res.status(404).json({ successful: false, message: "Payout_Not_Found" });

        const updated = await approvePayout(payout, { note: req.body?.note });
        return res.json({ successful: true, data: updated });
    } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ successful: false, message: err.message });
        next(err);
    }
});

// Mark a manual (off-platform) disbursement as paid, recording a reference.
router.post('/admin/payouts/:payout_id/mark-paid', authenticateToken, requireAdmin, async (req, res, next) => {
    try {
        const payoutId = parsePayoutId(req, res);
        if (payoutId === null) return;
        const payout = await loadPayout(payoutId);
        if (!payout) return res.status(404).json({ successful: false, message: "Payout_Not_Found" });

        const updated = await markPaid(payout, { reference: req.body?.reference });
        return res.json({ successful: true, data: updated });
    } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ successful: false, message: err.message });
        next(err);
    }
});

// Reject and refund the held funds back to the streamer's wallet.
router.post('/admin/payouts/:payout_id/reject', authenticateToken, requireAdmin, async (req, res, next) => {
    try {
        const payoutId = parsePayoutId(req, res);
        if (payoutId === null) return;
        const payout = await loadPayout(payoutId);
        if (!payout) return res.status(404).json({ successful: false, message: "Payout_Not_Found" });

        const updated = await rejectPayout(payout, { note: req.body?.note });
        return res.json({ successful: true, data: updated });
    } catch (err) {
        if (err.statusCode) return res.status(err.statusCode).json({ successful: false, message: err.message });
        next(err);
    }
});

router.get('/transactions', authenticateToken, async (req, res, next) => {
    try {
        const requests = await prisma.live_payout_request.findMany({
            where: { streamer: { user_id: req.user.user_id } },
            orderBy: { created_at: 'desc' }
        });
        return res.json({ successful: true, data: requests });
    } catch (err) {
        next(err);
    }
});

export default router;