import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { requireAdmin } from '../middleware/require-admin.js';
import redis from '../utils/redis-client.js';

const router = express.Router();

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

router.get('/dashboard', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user.user_id;

    const adsWallet = await prisma.ads_wallet.findUnique({
      where: { user_id: userId }
    });

    if (!adsWallet) {
      return res.json({
        successful: true,
        data: {
          total_impressions: 0,
          total_clicks: 0,
          total_spent: 0.00,
          average_ctr: "0.00%"
        }
      });
    }

    const campaigns = await prisma.ads_campaign.findMany({
      where: { ads_wallet_id: adsWallet.ads_wallet_id },
      select: { campaign_id: true, total_spent: true }
    });

    const campaignIds = campaigns.map(c => c.campaign_id);
    const totalSpent = campaigns.reduce((sum, c) => sum + Number(c.total_spent), 0);

    const [impressions, clicks] = await Promise.all([
      prisma.ad_impressions.count({
        where: { ad_id: { in: campaignIds }, event_type: "impression" }
      }),
      prisma.ad_impressions.count({
        where: { ad_id: { in: campaignIds }, event_type: "click" }
      })
    ]);

    const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0.0;

    return res.json({
      successful: true,
      data: {
        total_impressions: impressions,
        total_clicks: clicks,
        total_spent: parseFloat(totalSpent.toFixed(2)),
        average_ctr: `${ctr.toFixed(2)}%`
      }
    });
  } catch (err) {
    next(err);
  }
});

router.get('/campaign/:id/summary', authenticateToken, async (req, res, next) => {
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

    const [impressions, clicks] = await Promise.all([
      prisma.ad_impressions.count({
        where: { ad_id: campaignId, event_type: "impression" }
      }),
      prisma.ad_impressions.count({
        where: { ad_id: campaignId, event_type: "click" }
      })
    ]);

    const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0.0;

    return res.json({
      successful: true,
      data: {
        campaign_id: campaignId,
        title: campaign.title,
        status: campaign.status,
        total_impressions: impressions,
        total_clicks: clicks,
        total_spent: parseFloat(Number(campaign.total_spent).toFixed(2)),
        daily_spent: parseFloat(Number(campaign.spent_today).toFixed(2)),
        daily_budget: parseFloat(Number(campaign.daily_budget).toFixed(2)),
        ctr: `${ctr.toFixed(2)}%`,
        currency: campaign.ads_wallet.currency,
        retrieved_at: new Date()
      }
    });
  } catch (err) {
    next(err);
  }
});

router.get('/campaign/:id/time-series', authenticateToken, async (req, res, next) => {
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

    const logs = await prisma.ad_impressions.findMany({
      where: { ad_id: campaignId },
      select: { event_type: true, created_at: true, revenue_generated: true },
      orderBy: { created_at: 'asc' }
    });

    const grouped = {};
    for (const log of logs) {
      const dateStr = log.created_at.toISOString().split('T')[0];
      if (!grouped[dateStr]) {
        grouped[dateStr] = { date: dateStr, impressions: 0, clicks: 0, spend: 0.0 };
      }
      if (log.event_type === "impression") {
        grouped[dateStr].impressions += 1;
      } else if (log.event_type === "click") {
        grouped[dateStr].clicks += 1;
      }
      grouped[dateStr].spend += Number(log.revenue_generated);
    }

    return res.json({
      successful: true,
      data: Object.values(grouped)
    });
  } catch (err) {
    next(err);
  }
});

router.get('/campaign/:id/demographics', authenticateToken, async (req, res, next) => {
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

    const logs = await prisma.ad_impressions.findMany({
      where: { ad_id: campaignId, NOT: { viewer_id: 0 } },
      select: { event_type: true, viewer_id: true }
    });

    const profileIds = [...new Set(logs.map(l => l.viewer_id))];
    const profiles = await prisma.social_profile.findMany({
      where: { profile_id: { in: profileIds } },
      select: {
        profile_id: true,
        user: {
          select: { country: true, city: true }
        }
      }
    });

    const profileGeoMap = new Map();
    for (const p of profiles) {
      const geoKey = `${p.user?.city || "Unknown"}, ${p.user?.country || "Unknown"}`;
      profileGeoMap.set(p.profile_id, geoKey);
    }

    const geoGroups = {};
    for (const log of logs) {
      const geo = profileGeoMap.get(log.viewer_id) || "Unknown, Unknown";
      if (!geoGroups[geo]) {
        geoGroups[geo] = { location: geo, impressions: 0, clicks: 0 };
      }
      if (log.event_type === "impression") {
        geoGroups[geo].impressions += 1;
      } else if (log.event_type === "click") {
        geoGroups[geo].clicks += 1;
      }
    }

    return res.json({
      successful: true,
      data: Object.values(geoGroups)
    });
  } catch (err) {
    next(err);
  }
});

router.get('/campaign/:id/roas', authenticateToken, async (req, res, next) => {
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

    const totalCost = Number(campaign.total_spent);

    const checkouts = await prisma.checkouts.findMany({
      where: {
        shared_ref_code: {
          user_shared_ref_code_ref_codeTouser: {
            user_id: userId
          }
        }
      },
      select: { total: true }
    });

    const totalConversionRevenue = checkouts.reduce((sum, c) => sum + Number(c.total), 0);
    const roas = totalCost > 0 ? totalConversionRevenue / totalCost : 0.0;

    return res.json({
      successful: true,
      data: {
        campaign_id: campaignId,
        total_ad_cost: totalCost,
        total_conversion_revenue: totalConversionRevenue,
        roas_multiplier: parseFloat(roas.toFixed(2)),
        currency: campaign.ads_wallet.currency
      }
    });
  } catch (err) {
    next(err);
  }
});

router.get('/campaign/:id/engagement', authenticateToken, async (req, res, next) => {
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

    const socialPost = await prisma.social_feed.findFirst({
      where: { caption_text: { contains: `[Campaign #${campaignId}]` } },
      include: {
        _count: {
          select: {
            social_comments: true,
            social_interactions: true,
            bookmarks: true
          }
        }
      }
    });

    return res.json({
      successful: true,
      data: {
        campaign_id: campaignId,
        likes: socialPost?._count.social_interactions || 0,
        comments: socialPost?._count.social_comments || 0,
        saves: socialPost?._count.bookmarks || 0
      }
    });
  } catch (err) {
    next(err);
  }
});

router.get('/campaign/:id/diagnostics', authenticateToken, async (req, res, next) => {
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

    const [impressions, clicks] = await Promise.all([
      prisma.ad_impressions.count({ where: { ad_id: campaignId, event_type: "impression" } }),
      prisma.ad_impressions.count({ where: { ad_id: campaignId, event_type: "click" } })
    ]);

    const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0.0;
    const suggestions = [];

    if (ctr < 1.0 && impressions > 100) {
      suggestions.push("Your Click-Through Rate is low. Consider increasing your CPC bid to win higher-relevancy auctions.");
      suggestions.push("Optimize your creative assets. A more engaging headline or 1:1 image can improve CTR.");
    }

    if (impressions === 0) {
      suggestions.push("Your ad has zero impressions. Check if your Ad Account balance is 0 or if targeting is too narrow.");
    }

    return res.json({
      successful: true,
      data: {
        campaign_id: campaignId,
        ctr: `${ctr.toFixed(2)}%`,
        status: ctr < 1.0 ? "NEEDS_OPTIMIZATION" : "HEALTHY",
        suggestions
      }
    });
  } catch (err) {
    next(err);
  }
});

router.get('/campaign/:id/export/csv', authenticateToken, async (req, res, next) => {
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

    const logs = await prisma.ad_impressions.findMany({
      where: { ad_id: campaignId },
      orderBy: { created_at: 'asc' }
    });

    const grouped = {};
    for (const log of logs) {
      const dateStr = log.created_at.toISOString().split('T')[0];
      if (!grouped[dateStr]) {
        grouped[dateStr] = { date: dateStr, impressions: 0, clicks: 0, spend: 0.0 };
      }
      if (log.event_type === "impression") {
        grouped[dateStr].impressions += 1;
      } else if (log.event_type === "click") {
        grouped[dateStr].clicks += 1;
      }
      grouped[dateStr].spend += Number(log.revenue_generated);
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=strug-campaign-${campaignId}-report.csv`);

    let csvContent = 'Date,Impressions,Clicks,Spend(LKR)\n';
    for (const row of Object.values(grouped)) {
      csvContent += `${row.date},${row.impressions},${row.clicks},${row.spend.toFixed(2)}\n`;
    }

    return res.status(200).send(csvContent);
  } catch (err) {
    next(err);
  }
});

router.get('/campaign/:id/live', authenticateToken, async (req, res, next) => {
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

    const spentTodayRedis = await redis.get(`ads:campaign:${campaignId}:spent_today`) || "0";

    return res.json({
      successful: true,
      data: {
        campaign_id: campaignId,
        live_spent_today: parseFloat(spentTodayRedis),
        currency: campaign.ads_wallet.currency,
        polled_at: new Date()
      }
    });
  } catch (err) {
    next(err);
  }
});

router.get('/admin/summary', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const [totalImpressions, totalClicks, totalSpendLog] = await Promise.all([
      prisma.ad_impressions.count({ where: { event_type: "impression" } }),
      prisma.ad_impressions.count({ where: { event_type: "click" } }),
      prisma.ad_impressions.aggregate({ _sum: { revenue_generated: true } })
    ]);

    return res.json({
      successful: true,
      data: {
        global_impressions: totalImpressions,
        global_clicks: totalClicks,
        global_spend: Number(totalSpendLog._sum.revenue_generated || 0).toFixed(2),
        global_average_ctr: totalImpressions > 0 ? `${((totalClicks / totalImpressions) * 100).toFixed(2)}%` : "0.0%"
      }
    });
  } catch (err) {
    next(err);
  }
});

router.post('/admin/archive', authenticateToken, requireAdmin, async (req, res, next) => {
  try {
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const oldLogsCount = await prisma.ad_impressions.count({
      where: { created_at: { lt: ninetyDaysAgo } }
    });

    if (oldLogsCount > 0) {
      await prisma.ad_impressions.deleteMany({
        where: { created_at: { lt: ninetyDaysAgo } }
      });
    }

    return res.json({
      successful: true,
      message: `System Archiving Job Executed. Pruned and archived ${oldLogsCount} logs older than 90 days.`,
      archived_count: oldLogsCount
    });
  } catch (err) {
    next(err);
  }
});

export default router;