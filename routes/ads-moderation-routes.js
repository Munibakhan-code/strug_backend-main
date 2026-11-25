import express from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import xss from 'xss';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { analyzeImageUrl } from '../utils/content-safety.js';
import { pushToVideoQueue } from '../utils/azure-queue.js';
import { syncCampaignToRedis } from '../utils/ads-delivery-engine.js';

const router = express.Router();

const reportAdSchema = z.object({
  reason: z.string().min(5).max(1000)
});

const adminResolveSchema = z.object({
  action: z.enum(['APPROVE', 'REJECT']),
  note: z.string().max(500).optional()
});

const CLICKBAIT_TRIGGERS = [
  /you won't believe/i,
  /shocking/i,
  /must watch/i,
  /secret revealed/i,
  /make millions fast/i,
  /doctor's secret/i,
  /lose weight instantly/i
];

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

function analyzeClickbaitHeadline(headline) {
  if (!headline) return { is_clickbait: false, score: 0 };
  let score = 0;

  const capsCount = (headline.match(/[A-Z]/g) || []).length;
  const totalLetters = (headline.match(/[a-zA-Z]/g) || []).length;
  if (totalLetters > 5 && (capsCount / totalLetters) > 0.6) {
    score += 2;
  }

  if (/(!!|\?\?)/.test(headline)) {
    score += 2;
  }

  const hasTrigger = CLICKBAIT_TRIGGERS.some(trigger => trigger.test(headline));
  if (hasTrigger) {
    score += 3;
  }

  return {
    is_clickbait: score >= 3,
    score
  };
}

function generateMediaHash(mediaUrl) {
  if (!mediaUrl || mediaUrl === 'pending_upload') return null;
  return crypto.createHash('md5').update(mediaUrl).digest('hex');
}

router.post('/:id/scan', authenticateToken, async (req, res, next) => {
  try {
    const campaignId = Number(req.params.id);
    const userId = req.user.user_id;

    const campaign = await prisma.ads_campaign.findUnique({
      where: { campaign_id: campaignId },
      include: { ads_wallet: true }
    });

    if (!campaign || campaign.ads_wallet.user_id !== userId) {
      return res.status(404).json({
        successful: false,
        message: "Campaign not found."
      });
    }

    const requiredBudget = Number(campaign.total_budget) > 0 ? Number(campaign.total_budget) : Number(campaign.daily_budget);
    const wallet = await prisma.ads_wallet.findUnique({
      where: { user_id: userId }
    });

    if (Number(campaign.total_budget) === 0 && (!wallet || Number(wallet.balance) < requiredBudget)) {
      return res.status(400).json({
        successful: false,
        message: "Ad Account Wallet has insufficient funds to cover the campaign budget. Please top up your wallet first."
      });
    }

    const clickbaitResult = analyzeClickbaitHeadline(campaign.headline || campaign.title);
    const mediaHash = generateMediaHash(campaign.media_url);

    let isDuplicate = false;
    if (mediaHash) {
      const existingDuplicate = await prisma.ads_campaign.findFirst({
        where: {
          media_hash: mediaHash,
          campaign_id: { not: campaignId },
          status: "ACTIVE"
        }
      });
      isDuplicate = !!existingDuplicate;
    }

    let safety = { blocked: false, sensitive: false, safety_score: 1.0, categories: {} };
    if (campaign.media_url && campaign.media_url !== 'pending_upload') {
      safety = await analyzeImageUrl(campaign.media_url);
    }

    let finalStatus = "PENDING_REVIEW";
    if (safety.blocked || isDuplicate) {
      finalStatus = "REJECTED";
    } else if (safety.sensitive || clickbaitResult.is_clickbait) {
      finalStatus = "PENDING_REVIEW";
    } else {
      finalStatus = "PENDING_REVIEW";
    }

    const updated = await prisma.ads_campaign.update({
      where: { campaign_id: campaignId },
      data: {
        status: finalStatus,
        safety_score: safety.safety_score,
        is_sensitive: safety.sensitive || clickbaitResult.is_clickbait,
        media_hash: mediaHash
      }
    });

    if (finalStatus === "ACTIVE" && campaign.ad_type === "VIDEO") {
      const blobName = campaign.media_url.split('/').pop();
      await pushToVideoQueue(campaignId, blobName).catch(() => {});
    }

    await syncCampaignToRedis(campaignId);

    return res.json({
      successful: true,
      data: {
        campaign_id: campaignId,
        status: finalStatus,
        safety_score: safety.safety_score,
        is_sensitive: safety.sensitive,
        is_clickbait: clickbaitResult.is_clickbait,
        is_duplicate: isDuplicate
      }
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      const errMsg = err.issues?.[0]?.message || err.errors?.[0]?.message || "Validation failed";
      return res.status(400).json({ successful: false, error: errMsg, errors: err.issues || err.errors });
    }
    next(err);
  }
});

router.get('/:id/logs', authenticateToken, async (req, res, next) => {
  try {
    const campaignId = Number(req.params.id);
    const userId = req.user.user_id;

    const campaign = await prisma.ads_campaign.findUnique({
      where: { campaign_id: campaignId },
      include: { ads_wallet: true }
    });

    if (!campaign || campaign.ads_wallet.user_id !== userId) {
      return res.status(404).json({
        successful: false,
        message: "Campaign not found."
      });
    }

    return res.json({
      successful: true,
      data: {
        campaign_id: campaignId,
        safety_score: campaign.safety_score,
        is_sensitive: campaign.is_sensitive,
        status: campaign.status,
        updated_at: campaign.updated_at
      }
    });
  } catch (err) {
    next(err);
  }
});

router.get('/admin/queue', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const pendingQueue = await prisma.ads_campaign.findMany({
      where: { status: "PENDING_REVIEW" },
      orderBy: { updated_at: 'asc' }
    });

    return res.json({
      successful: true,
      data: pendingQueue
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/admin/:id/resolve', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const campaignId = Number(req.params.id);
    const validated = adminResolveSchema.parse(req.body);

    const campaign = await prisma.ads_campaign.findUnique({
      where: { campaign_id: campaignId }
    });

    if (!campaign) {
      return res.status(404).json({
        successful: false,
        message: "Campaign not found."
      });
    }

    const finalStatus = validated.action === 'APPROVE' ? 'ACTIVE' : 'REJECTED';

    const updated = await prisma.ads_campaign.update({
      where: { campaign_id: campaignId },
      data: { status: finalStatus }
    });

    await syncCampaignToRedis(campaignId);

    return res.json({
      successful: true,
      message: `Campaign has been ${finalStatus.toLowerCase()} by admin.`,
      data: updated
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      const errMsg = err.issues?.[0]?.message || err.errors?.[0]?.message || "Validation failed";
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    next(err);
  }
});

router.post('/:id/report', authenticateToken, async (req, res, next) => {
  try {
    const campaignId = Number(req.params.id);
    const validated = reportAdSchema.parse(req.body);
    const reporterId = req.user.profile_id || req.user.user_id;

    const campaign = await prisma.ads_campaign.findUnique({
      where: { campaign_id: campaignId }
    });

    if (!campaign) {
      return res.status(404).json({
        successful: false,
        message: "Ad campaign not found."
      });
    }

    const report = await prisma.social_report.create({
      data: {
        reporter_id: reporterId,
        target_type: "AD",
        target_id: campaignId,
        reason: xss(validated.reason)
      }
    });

    await prisma.ads_campaign.update({
      where: { campaign_id: campaignId },
      data: { status: "PENDING_REVIEW" }
    });

    await syncCampaignToRedis(campaignId);

    return res.status(201).json({
      successful: true,
      message: "Ad has been reported and placed under pending review.",
      data: report
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      const errMsg = err.issues?.[0]?.message || err.errors?.[0]?.message || "Validation failed";
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    next(err);
  }
});

router.get('/admin/reports', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const reports = await prisma.social_report.findMany({
      where: { target_type: "AD" },
      orderBy: { created_at: 'desc' }
    });

    return res.json({
      successful: true,
      data: reports
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/admin/reports/:id/resolve', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const reportId = Number(req.params.id);
    const validated = adminResolveSchema.parse(req.body);

    const report = await prisma.social_report.findUnique({
      where: { report_id: reportId }
    });

    if (!report || report.target_type !== "AD") {
      return res.status(404).json({
        successful: false,
        message: "Ad report not found."
      });
    }

    const finalReportStatus = validated.action === 'APPROVE' ? 'resolved' : 'dismissed';

    await prisma.$transaction([
      prisma.social_report.update({
        where: { report_id: reportId },
        data: { status: finalReportStatus }
      }),
      prisma.ads_campaign.update({
        where: { campaign_id: report.target_id },
        data: { status: validated.action === 'APPROVE' ? 'REJECTED' : 'ACTIVE' }
      })
    ]);

    await syncCampaignToRedis(report.target_id);

    return res.json({
      successful: true,
      message: `Report has been marked as ${finalReportStatus}.`
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      const errMsg = err.issues?.[0]?.message || err.errors?.[0]?.message || "Validation failed";
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    next(err);
  }
});

router.post('/check-link', authenticateToken, async (req, res, next) => {
  try {
    const schema = z.object({ url: z.string().url() });
    const validated = schema.parse(req.body);

    const PHISHING_BLACKLIST = [
      /malicious/i,
      /scam/i,
      /phish/i,
      /steal-credentials/i
    ];

    const isFlagged = PHISHING_BLACKLIST.some(pattern => pattern.test(validated.url));

    return res.json({
      successful: true,
      safe: !isFlagged,
      message: !isFlagged ? "URL is classified as safe." : "URL matches blacklisted phishing patterns."
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      const errMsg = err.issues?.[0]?.message || err.errors?.[0]?.message || "Validation failed";
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    next(err);
  }
});

router.get('/admin/system/stats', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const [totalCampaigns, pendingCount, rejectedCount] = await Promise.all([
      prisma.ads_campaign.count(),
      prisma.ads_campaign.count({ where: { status: "PENDING_REVIEW" } }),
      prisma.ads_campaign.count({ where: { status: "REJECTED" } })
    ]);

    return res.json({
      successful: true,
      data: {
        total_campaigns: totalCampaigns,
        pending_review_count: pendingCount,
        rejected_count: rejectedCount,
        integrity_percentage: totalCampaigns > 0 ? parseFloat(((totalCampaigns - rejectedCount) / totalCampaigns * 100).toFixed(1)) : 100.0
      }
    });
  } catch (err) {
    next(err);
  }
});

export default router;