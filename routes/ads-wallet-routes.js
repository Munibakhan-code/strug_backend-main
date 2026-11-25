import express from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { getRegionData } from '../utils/tax-config.js';

const router = express.Router();

const topupSchema = z.object({
  amount: z.number().positive().min(100)
});

const withdrawSchema = z.object({
  amount: z.number().positive().min(100)
});

const preauthHoldSchema = z.object({
  campaign_id: z.number().int().positive(),
  amount: z.number().positive()
});

const EXCHANGE_RATES_BASE_USD = {
  USD: 1.0,
  LKR: 300.0,
  CAD: 1.35
};

function convertCurrency(amount, from, to) {
  if (from === to) return amount;
  const rateFrom = EXCHANGE_RATES_BASE_USD[from] || 1.0;
  const rateTo = EXCHANGE_RATES_BASE_USD[to] || 1.0;
  const amountInUSD = amount / rateFrom;
  return amountInUSD * rateTo;
}

function generateLedgerHash(payload) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

async function checkLowBalanceAndNotify(userId, balance, currency) {
  const thresholdUSD = parseFloat(process.env.AD_MIN_WALLET_TOPUP_LKR || "1500.00") / 300.0;
  const balanceUSD = convertCurrency(balance, currency, 'USD');

  if (balanceUSD < thresholdUSD) {
    const user = await prisma.user.findUnique({
      where: { user_id: userId },
      select: { email: true, name: true, language: true }
    });

    if (user?.email) {
      const { decrypt } = await import('../utils/crypto.js');
      const plainEmail = decrypt(user.email);
      const mailerEvents = (await import('../utils/mailer-event.js')).default;
      mailerEvents.emit('send_email', {
        templateName: 'ads-low-balance',
        variables: {
          name: user.name || 'Advertiser',
          balance: parseFloat(balance).toFixed(2),
          currency
        },
        to: plainEmail,
        subjectKey: 'emails.ads.low_balance_subject',
        user,
      });
    }
  }
}

async function enforceNegativeBalanceLock(tx, userId, balance, currency) {
  const balanceUSD = convertCurrency(balance, currency, 'USD');
  if (balanceUSD <= 0) {
    await tx.ads_campaign.updateMany({
      where: {
        ads_wallet: { user_id: userId },
        status: { in: ["ACTIVE", "PENDING_REVIEW"] }
      },
      data: { status: "OUT_OF_BUDGET" }
    });
  }
}

async function trackDailySpendAlert(campaignId, spentToday, dailyBudget, userId) {
  const ratio = parseFloat(spentToday) / parseFloat(dailyBudget);
  let milestone = null;

  if (ratio >= 1.0) milestone = '100';
  else if (ratio >= 0.90) milestone = '90';
  else if (ratio >= 0.80) milestone = '80';

  if (!milestone) return;

  const todayStr = new Date().toISOString().split('T')[0];
  const redis = (await import('../utils/redis-client.js')).default;
  const lockKey = `campaign:${campaignId}:alert:${milestone}:${todayStr}`;

  let alreadySent = false;
  try {
    const value = await redis.get(lockKey);
    alreadySent = value === 'true';
  } catch (err) {
    console.warn('[ads-wallet] Redis unavailable during spend alert check, failing open:', err.message);
  }

  if (alreadySent) return;

  try {
    await redis.set(lockKey, 'true', 'EX', 86400);
  } catch (err) {
    console.warn('[ads-wallet] Redis unavailable during spend alert set:', err.message);
  }

  const user = await prisma.user.findUnique({
    where: { user_id: userId },
    select: { email: true, name: true, language: true }
  });

  if (user?.email) {
    const { decrypt } = await import('../utils/crypto.js');
    const plainEmail = decrypt(user.email);
    const mailerEvents = (await import('../utils/mailer-event.js')).default;
    mailerEvents.emit('send_email', {
      templateName: 'ads-spend-alert',
      variables: {
        name: user.name || 'Advertiser',
        campaign_id: campaignId,
        percentage: milestone
      },
      to: plainEmail,
      subjectKey: 'emails.ads.spend_alert_subject',
      user,
    });
  }
}

router.post('/topup', authenticateToken, async (req, res, next) => {
  try {
    const validated = topupSchema.parse(req.body);
    const userId = req.user.user_id;
    const amountToTransfer = validated.amount;

    const adsProfile = await prisma.ads_account_profile.findUnique({
      where: { user_id: userId }
    });

    if (!adsProfile) {
      return res.status(400).json({
        successful: false,
        message: "Ads account profile must be initialized first."
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT * FROM "strug_wallet" WHERE "user_id" = ${userId} FOR UPDATE`;
      await tx.$executeRaw`SELECT * FROM "ads_wallet" WHERE "user_id" = ${userId} FOR UPDATE`;

      const coreWallet = await tx.strug_wallet.findUnique({
        where: { user_id: userId }
      });

      if (!coreWallet || Number(coreWallet.balance) < amountToTransfer) {
        throw new Error('INSUFFICIENT_FUNDS');
      }

      const adsWallet = await tx.ads_wallet.findUnique({
        where: { user_id: userId }
      });

      const convertedAmount = convertCurrency(
        amountToTransfer,
        coreWallet.currency,
        adsWallet.currency
      );

      await tx.strug_wallet.update({
        where: { user_id: userId },
        data: { balance: { decrement: amountToTransfer } }
      });

      const finalAdsBalance = Number(adsWallet.balance) + convertedAmount;

      await tx.ads_wallet.update({
        where: { user_id: userId },
        data: { balance: finalAdsBalance }
      });

      const timestamp = new Date();
      const txHash = generateLedgerHash({
        userId,
        amountToTransfer,
        convertedAmount,
        fromCurrency: coreWallet.currency,
        toCurrency: adsWallet.currency,
        timestamp
      });

      const debitTx = await tx.wallet_transaction.create({
        data: {
          user_id: userId,
          amount: -amountToTransfer,
          type: "debit",
          source: "ad_wallet_topup",
          status: "completed",
          description: `Ads Top-up. Ledger hash: ${txHash}`,
          created_at: timestamp
        }
      });

      return {
        debitTx,
        ads_balance: finalAdsBalance,
        core_balance: Number(coreWallet.balance) - amountToTransfer,
        ledger_hash: txHash
      };
    }, { timeout: 30000 });

    await checkLowBalanceAndNotify(userId, result.ads_balance, adsProfile.currency);

    return res.json({
      successful: true,
      data: result
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    if (err.message === 'INSUFFICIENT_FUNDS') {
      return res.status(400).json({
        successful: false,
        message: "Insufficient funds in your main core wallet."
      });
    }
    next(err);
  }
});

router.post('/withdraw', authenticateToken, async (req, res, next) => {
  try {
    const validated = withdrawSchema.parse(req.body);
    const userId = req.user.user_id;
    const amountToWithdraw = validated.amount;

    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT * FROM "strug_wallet" WHERE "user_id" = ${userId} FOR UPDATE`;
      await tx.$executeRaw`SELECT * FROM "ads_wallet" WHERE "user_id" = ${userId} FOR UPDATE`;

      const adsWallet = await tx.ads_wallet.findUnique({
        where: { user_id: userId }
      });

      if (!adsWallet || Number(adsWallet.balance) < amountToWithdraw) {
        throw new Error('INSUFFICIENT_ADS_FUNDS');
      }

      const coreWallet = await tx.strug_wallet.findUnique({
        where: { user_id: userId }
      });

      const convertedAmount = convertCurrency(
        amountToWithdraw,
        adsWallet.currency,
        coreWallet.currency
      );

      const finalAdsBalance = Number(adsWallet.balance) - amountToWithdraw;

      await tx.ads_wallet.update({
        where: { user_id: userId },
        data: { balance: finalAdsBalance }
      });

      await tx.strug_wallet.update({
        where: { user_id: userId },
        data: { balance: { increment: convertedAmount } }
      });

      await enforceNegativeBalanceLock(tx, userId, finalAdsBalance, adsWallet.currency);

      const timestamp = new Date();
      const txHash = generateLedgerHash({
        userId,
        amountToWithdraw,
        convertedAmount,
        fromCurrency: adsWallet.currency,
        toCurrency: coreWallet.currency,
        timestamp
      });

      const creditTx = await tx.wallet_transaction.create({
        data: {
          user_id: userId,
          amount: convertedAmount,
          type: "credit",
          source: "ad_wallet_withdrawal",
          status: "completed",
          description: `Ads Withdrawal. Ledger hash: ${txHash}`,
          created_at: timestamp
        }
      });

      return {
        creditTx,
        ads_balance: finalAdsBalance,
        core_balance: Number(coreWallet.balance) + convertedAmount,
        ledger_hash: txHash
      };
    }, { timeout: 30000 });

    await checkLowBalanceAndNotify(userId, result.ads_balance, result.creditTx.source);

    return res.json({
      successful: true,
      data: result
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    if (err.message === 'INSUFFICIENT_ADS_FUNDS') {
      return res.status(400).json({
        successful: false,
        message: "Insufficient funds in your Ads sub-wallet."
      });
    }
    next(err);
  }
});

router.get('/balance', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user.user_id;

    const adsWallet = await prisma.ads_wallet.findUnique({
      where: { user_id: userId }
    });

    if (!adsWallet) {
      return res.status(404).json({
        successful: false,
        message: "Ads wallet not found."
      });
    }

    const transactions = await prisma.wallet_transaction.findMany({
      where: {
        user_id: userId,
        source: {
          in: ['ad_wallet_topup', 'ad_wallet_withdrawal', 'ad_campaign']
        }
      },
      orderBy: { created_at: 'desc' },
      take: 20
    });

    return res.json({
      successful: true,
      data: {
        ads_wallet_id: adsWallet.ads_wallet_id,
        balance: adsWallet.balance,
        currency: adsWallet.currency,
        status: adsWallet.status,
        transactions
      }
    });
  } catch (err) {
    next(err);
  }
});

router.get('/audit-reconciliation', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const targetUserId = req.query.user_id ? Number(req.query.user_id) : req.user.user_id;

    const [coreWallet, adsWallet, transactions] = await Promise.all([
      prisma.strug_wallet.findUnique({ where: { user_id: targetUserId } }),
      prisma.ads_wallet.findUnique({ where: { user_id: targetUserId } }),
      prisma.wallet_transaction.findMany({ where: { user_id: targetUserId } })
    ]);

    if (!coreWallet || !adsWallet) {
      return res.status(404).json({
        successful: false,
        message: "Wallets not found for reconciliation."
      });
    }

    const calculatedCoreBalance = transactions
      .filter(t => t.source !== 'ad_wallet_topup' && t.source !== 'ad_wallet_withdrawal')
      .reduce((sum, t) => sum + Number(t.amount), 0);

    const isCoreReconciled = Math.abs(calculatedCoreBalance - Number(coreWallet.balance)) < 0.01;

    return res.json({
      successful: true,
      audit: {
        user_id: targetUserId,
        core_wallet: {
          actual_balance: Number(coreWallet.balance),
          calculated_balance: calculatedCoreBalance,
          is_reconciled: isCoreReconciled
        },
        ads_wallet: {
          balance: Number(adsWallet.balance),
          currency: adsWallet.currency
        },
        total_transactions_evaluated: transactions.length,
        reconciliation_status: isCoreReconciled ? "SUCCESS" : "DISCREPANCY_DETECTED",
        audited_at: new Date()
      }
    });
  } catch (err) {
    next(err);
  }
});

router.post('/preauth-hold', authenticateToken, async (req, res, next) => {
  try {
    const validated = preauthHoldSchema.parse(req.body);
    const userId = req.user.user_id;

    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT * FROM "ads_wallet" WHERE "user_id" = ${userId} FOR UPDATE`;

      const wallet = await tx.ads_wallet.findUnique({
        where: { user_id: userId }
      });

      if (!wallet || Number(wallet.balance) < validated.amount) {
        throw new Error('INSUFFICIENT_ADS_FUNDS');
      }

      const finalAdsBalance = Number(wallet.balance) - validated.amount;

      await tx.ads_wallet.update({
        where: { user_id: userId },
        data: { balance: finalAdsBalance }
      });

      await enforceNegativeBalanceLock(tx, userId, finalAdsBalance, wallet.currency);

      // Ownership check: a campaign belongs to the caller only if it hangs off the caller's
      // ads_wallet (ads_campaign has no user_id — ownership is via ads_wallet_id). Without this
      // any user could debit their own wallet while inflating/mutating another user's campaign.
      const owned = await tx.ads_campaign.findUnique({
        where: { campaign_id: validated.campaign_id },
        select: { ads_wallet_id: true },
      });
      if (!owned || owned.ads_wallet_id !== wallet.ads_wallet_id) {
        throw new Error('CAMPAIGN_NOT_OWNED');
      }

      const updatedCampaign = await tx.ads_campaign.update({
        where: { campaign_id: validated.campaign_id },
        data: {
          total_budget: { increment: validated.amount },
          status: "PENDING_REVIEW"
        }
      });

      await trackDailySpendAlert(
        updatedCampaign.campaign_id,
        updatedCampaign.spent_today,
        updatedCampaign.daily_budget,
        userId
      );

      return {
        campaign: updatedCampaign,
        remaining_wallet_balance: finalAdsBalance,
        currency: wallet.currency
      };
    }, { timeout: 30000 });

    await checkLowBalanceAndNotify(userId, result.remaining_wallet_balance, result.currency || 'CAD');

    return res.json({
      successful: true,
      data: result
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    if (err.message === 'INSUFFICIENT_ADS_FUNDS') {
      return res.status(400).json({
        successful: false,
        message: "Insufficient funds in your Ads sub-wallet."
      });
    }
    if (err.message === 'CAMPAIGN_NOT_OWNED') {
      return res.status(403).json({
        successful: false,
        message: "You can only fund your own campaigns."
      });
    }
    next(err);
  }
});

export default router;