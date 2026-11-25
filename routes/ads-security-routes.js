import express from 'express';
import { z } from 'zod';
import xss from 'xss';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { deleteAzureBlob } from '../utils/azure-cleanup.js';
import { getRegionData } from '../utils/tax-config.js';
import redis from '../utils/redis-client.js';

const router = express.Router();

const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$|^([\da-fA-F]{1,4}:){7}[\da-fA-F]{1,4}$/;

const blacklistIpSchema = z.object({
  ip_address: z.string().refine(val => ipRegex.test(val), {
    message: "Invalid IP address format. Must be a valid IPv4 or IPv6 address."
  })
});

const billingProfileSchema = z.object({
  corporate_name: z.string().min(2).max(255),
  tax_id: z.string().min(5).max(50),
  card_token: z.string()
});

const auditActivitySchema = z.object({
  action: z.string().min(2).max(100),
  description: z.string().min(5).max(1000)
});

router.delete('/gdpr/terminate', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user.user_id;

    const profile = await prisma.ads_account_profile.findUnique({
      where: { user_id: userId },
      include: {
        campaigns: true,
        brands: true
      }
    });

    if (!profile) {
      return res.status(404).json({
        successful: false,
        message: "No Ad Account found to terminate."
      });
    }

    const deleteTasks = [];
    const container = process.env.AZURE_ADS_CONTAINER || 'social-ads';

    for (const campaign of profile.campaigns) {
      if (campaign.media_url && campaign.media_url !== 'pending_upload') {
        deleteTasks.push(deleteAzureBlob(container, campaign.media_url));
      }
      if (campaign.fallback_media_url) {
        deleteTasks.push(deleteAzureBlob(container, campaign.fallback_media_url));
      }
    }

    for (const brand of profile.brands) {
      if (brand.logo_url) {
        deleteTasks.push(deleteAzureBlob(container, brand.logo_url));
      }
    }

    await Promise.all(deleteTasks);

    await prisma.$transaction([
      prisma.ads_tos_agreement.deleteMany({ where: { profile_id: profile.profile_id } }),
      prisma.ads_brand_profile.deleteMany({ where: { profile_id: profile.profile_id } }),
      prisma.ads_member.deleteMany({ where: { profile_id: profile.profile_id } }),
      prisma.ads_campaign.deleteMany({ where: { ads_wallet_id: profile.profile_id } }),
      prisma.ads_wallet.deleteMany({ where: { user_id: userId } }),
      prisma.ads_account_profile.delete({ where: { profile_id: profile.profile_id } })
    ]);

    return res.json({
      successful: true,
      message: "Ad Account and all related cloud assets deleted permanently."
    });
  } catch (err) {
    next(err);
  }
});

router.post('/gdpr/anonymize', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const schema = z.object({ target_user_id: z.number().int().positive() });
    const validated = schema.parse(req.body);

    const result = await prisma.ad_impressions.updateMany({
      where: { viewer_id: validated.target_user_id },
      data: { viewer_id: 0 }
    });

    return res.json({
      successful: true,
      message: "Anonymization complete. User identity masked in historical ad logs.",
      records_masked: result.count
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    next(err);
  }
});

router.get('/audit/reconciliation', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user.user_id;

    const [adsWallet, transactions] = await Promise.all([
      prisma.ads_wallet.findUnique({ where: { user_id: userId } }),
      prisma.wallet_transaction.findMany({
        where: {
          user_id: userId,
          source: { in: ['ad_wallet_topup', 'ad_wallet_withdrawal', 'ad_campaign'] }
        }
      })
    ]);

    if (!adsWallet) {
      return res.status(404).json({
        successful: false,
        message: "Ads wallet not found."
      });
    }

    const calculatedBalance = transactions.reduce((sum, t) => sum + Number(t.amount), 0);
    const discrepancy = Math.abs(calculatedBalance - Number(adsWallet.balance));
    const isReconciled = discrepancy < 0.01;

    return res.json({
      successful: true,
      reconciliation: {
        user_id: userId,
        ledger_total: calculatedBalance,
        wallet_balance: Number(adsWallet.balance),
        discrepancy,
        status: isReconciled ? "SUCCESS" : "DISCREPANCY_DETECTED",
        audited_at: new Date()
      }
    });
  } catch (err) {
    next(err);
  }
});

router.post('/shield/ip-blacklist', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const validated = blacklistIpSchema.parse(req.body);
    await redis.sadd("ads:shield:blacklist", validated.ip_address);

    return res.status(201).json({
      successful: true,
      message: `IP ${validated.ip_address} added to anti-fraud blacklist.`
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    next(err);
  }
});

router.get('/shield/check-ip', authenticateToken, async (req, res, next) => {
  try {
    const { ip } = req.query;
    if (!ip) return res.status(400).json({ successful: false, message: "IP parameter required" });

    const isBlacklisted = await redis.sismember("ads:shield:blacklist", String(ip));

    return res.json({
      successful: true,
      blacklisted: !!isBlacklisted
    });
  } catch (err) {
    next(err);
  }
});

router.get('/admin/blacklist', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const list = await redis.smembers("ads:shield:blacklist");
    return res.json({
      successful: true,
      data: list
    });
  } catch (err) {
    next(err);
  }
});

// NOTE: a fake `/webhook/stripe` endpoint used to live here — homemade HMAC over
// JSON.stringify with a hardcoded fallback secret ("stripe_secret_key_123"). It had no
// financial side effect but was a misleading second "webhook" surface and a copy-paste
// hazard. Removed 2026-08-08. The ONLY real Stripe webhook is /booking/webhook/stripe.

router.post('/audit/activity', authenticateToken, async (req, res, next) => {
  try {
    const validated = auditActivitySchema.parse(req.body);
    const userId = req.user.user_id;
    const ipAddress = req.ip || req.headers['x-forwarded-for'] || '127.0.0.1';

    const auditLog = await prisma.social_audit_log.create({
      data: {
        profile_id: userId,
        action: `ADS_MANAGER_${validated.action.toUpperCase()}`,
        description: xss(validated.description),
        ip_address: ipAddress
      }
    });

    return res.status(201).json({
      successful: true,
      data: auditLog
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    next(err);
  }
});

router.get('/billing/invoice/:id', authenticateToken, async (req, res, next) => {
  try {
    const campaignId = Number(req.params.id);
    const userId = req.user.user_id;

    const campaign = await prisma.ads_campaign.findUnique({
      where: { campaign_id: campaignId },
      include: { ads_wallet: { include: { user: true } } }
    });

    if (!campaign || campaign.ads_wallet.user_id !== userId) {
      return res.status(404).json({
        successful: false,
        message: "Campaign not found."
      });
    }

    const region = getRegionData(campaign.ads_wallet.user.country || "default");
    const subtotal = Number(campaign.total_spent);
    const taxAmount = subtotal * region.tax;
    const totalInvoiceAmount = subtotal + taxAmount;

    return res.json({
      successful: true,
      invoice: {
        invoice_number: `INV-STRUG-${campaignId}-${Date.now().toString().slice(-6)}`,
        campaign_title: campaign.title,
        advertiser_name: campaign.ads_wallet.user.name,
        country: campaign.ads_wallet.user.country,
        subtotal: parseFloat(subtotal.toFixed(2)),
        tax_rate: `${(region.tax * 100).toFixed(1)}%`,
        tax_amount: parseFloat(taxAmount.toFixed(2)),
        total_amount: parseFloat(totalInvoiceAmount.toFixed(2)),
        currency: campaign.ads_wallet.currency,
        issued_at: new Date()
      }
    });
  } catch (err) {
    next(err);
  }
});

router.post('/billing/profile', authenticateToken, async (req, res, next) => {
  try {
    const validated = billingProfileSchema.parse(req.body);
    const userId = req.user.user_id;

    const encryptedCardToken = encrypt(validated.card_token);

    const updated = await prisma.ads_account_profile.update({
      where: { user_id: userId },
      data: {
        business_name: xss(validated.corporate_name),
        // Middleware AEAD-encrypts tax_id (#1295); do not pre-encrypt here.
        tax_id: validated.tax_id,
        address: encryptedCardToken
      }
    });

    return res.status(201).json({
      successful: true,
      message: "Encrypted billing profile saved successfully."
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    next(err);
  }
});

export default router;