import express from 'express';
import { z } from 'zod';
import xss from 'xss';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import redis from '../utils/redis-client.js';

const router = express.Router();

const campaignSchema = z.object({
  title: z.string().min(2).max(255),
  objective: z.enum(['TRAFFIC', 'CONVERSIONS', 'AWARENESS', 'LEAD_GEN']).default('AWARENESS'),
  folder_tag: z.string().max(100).nullable().optional(),
  main_category: z.enum(['SOCIAL', 'FOOD_DELIVERY', 'SERVICES', 'ECOMMERCE', 'RENTALS', 'JOBS_TALENT', 'FINTECH']),
  sub_category: z.string().min(2).max(50),
  ad_type: z.enum(['IMAGE', 'VIDEO', 'INLINE_POST', 'FEATURED_LISTING']),
  vertical: z.string(),
  media_url: z.string().url(),
  target_url: z.string().url().nullable().optional(),
  bid_type: z.enum(['CPC', 'CPM', 'CPV']),
  bid_amount: z.number().positive(),
  daily_budget: z.number().positive(),
  total_budget: z.number().nonnegative().default(0)
});

const bulkImportSchema = z.array(campaignSchema);

const statusToggleSchema = z.object({
  status: z.enum(['ACTIVE', 'PAUSED'])
});

router.get('/system/taxonomy', authenticateToken, async (req, res, next) => {
  try {
    const taxonomy = {
      SOCIAL: ['strug_video', 'strug_shorts', 'strug_stream', 'strug_insta', 'strug_townhall'],
      FOOD_DELIVERY: ['restaurant', 'grocery', 'meal_kit', 'pharmacy', 'liquor'],
      SERVICES: ['home_repair', 'cleaning', 'tutoring', 'beauty_wellness', 'pet_care'],
      ECOMMERCE: ['clothing', 'electronics', 'home_decor', 'books_media', 'handmade'],
      RENTALS: ['realty', 'short_term', 'tool_rental', 'venue_booking'],
      JOBS_TALENT: ['backend_dev', 'design', 'celebrity', 'gigs'],
      FINTECH: ['loans', 'insurance', 'mortgage']
    };

    return res.json({
      successful: true,
      data: taxonomy
    });
  } catch (err) {
    next(err);
  }
});

router.post('/draft/autosave', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user.user_id;
    const draftKey = `campaign:draft:${userId}`;
    const payload = JSON.stringify(req.body);

    try {
      await redis.set(draftKey, payload, 'EX', 604800);
    } catch (redisErr) {
      console.warn('[ads-campaign] Redis offline, draft autosave bypassed:', redisErr.message);
    }

    return res.json({
      successful: true,
      message: "Draft saved to memory cache."
    });
  } catch (err) {
    next(err);
  }
});

router.get('/draft', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user.user_id;
    const draftKey = `campaign:draft:${userId}`;
    
    let draft = null;
    try {
      draft = await redis.get(draftKey);
    } catch (redisErr) {
      console.warn('[ads-campaign] Redis offline, draft retrieval bypassed:', redisErr.message);
    }

    if (!draft) {
      return res.status(404).json({
        successful: false,
        message: "No draft found."
      });
    }

    return res.json({
      successful: true,
      data: JSON.parse(draft)
    });
  } catch (err) {
    next(err);
  }
});

router.post('/create', authenticateToken, async (req, res, next) => {
  try {
    const validated = campaignSchema.parse(req.body);
    const userId = req.user.user_id;

    const adsWallet = await prisma.ads_wallet.findUnique({
      where: { user_id: userId }
    });

    if (!adsWallet) {
      return res.status(400).json({
        successful: false,
        message: "Ads wallet must be initialized before creating campaign."
      });
    }

    const sanitizedTitle = xss(validated.title);
    const sanitizedFolderTag = validated.folder_tag ? xss(validated.folder_tag) : null;
    const sanitizedSubCategory = xss(validated.sub_category);

    const campaign = await prisma.ads_campaign.create({
      data: {
        ads_wallet_id: adsWallet.ads_wallet_id,
        title: sanitizedTitle,
        objective: validated.objective,
        folder_tag: sanitizedFolderTag,
        main_category: validated.main_category,
        sub_category: sanitizedSubCategory,
        ad_type: validated.ad_type,
        vertical: validated.vertical,
        media_url: validated.media_url,
        target_url: validated.target_url || null,
        bid_type: validated.bid_type,
        bid_amount: validated.bid_amount,
        daily_budget: validated.daily_budget,
        total_budget: validated.total_budget,
        status: "DRAFT"
      }
    });

    const draftKey = `campaign:draft:${userId}`;
    try {
      await redis.del(draftKey);
    } catch (redisErr) {
      console.warn('[ads-campaign] Redis offline, draft deletion bypassed:', redisErr.message);
    }

    return res.status(201).json({
      successful: true,
      data: campaign
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    next(err);
  }
});

router.get('/me', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user.user_id;
    const { status, objective, folder_tag, main_category, sub_category } = req.query;

    const adsWallet = await prisma.ads_wallet.findUnique({
      where: { user_id: userId }
    });

    if (!adsWallet) {
      return res.json({ successful: true, data: [] });
    }

    const campaigns = await prisma.ads_campaign.findMany({
      where: {
        ads_wallet_id: adsWallet.ads_wallet_id,
        ...(status ? { status: String(status) } : {}),
        ...(objective ? { objective: String(objective) } : {}),
        ...(folder_tag ? { folder_tag: String(folder_tag) } : {}),
        ...(main_category ? { main_category: String(main_category) } : {}),
        ...(sub_category ? { sub_category: String(sub_category) } : {})
      },
      orderBy: { created_at: 'desc' }
    });

    return res.json({
      successful: true,
      data: campaigns
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', authenticateToken, async (req, res, next) => {
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
      data: campaign
    });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', authenticateToken, async (req, res, next) => {
  try {
    const campaignId = Number(req.params.id);
    const validated = campaignSchema.parse(req.body);
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

    if (campaign.status === "COMPLETED") {
      return res.status(400).json({
        successful: false,
        message: "Cannot modify a completed campaign."
      });
    }

    const updated = await prisma.ads_campaign.update({
      where: { campaign_id: campaignId },
      data: {
        title: xss(validated.title),
        objective: validated.objective,
        folder_tag: validated.folder_tag ? xss(validated.folder_tag) : null,
        main_category: validated.main_category,
        sub_category: xss(validated.sub_category),
        ad_type: validated.ad_type,
        vertical: validated.vertical,
        media_url: validated.media_url,
        target_url: validated.target_url || null,
        bid_type: validated.bid_type,
        bid_amount: validated.bid_amount,
        daily_budget: validated.daily_budget,
        total_budget: validated.total_budget
      }
    });

    return res.json({
      successful: true,
      data: updated
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    next(err);
  }
});

router.post('/:id/clone', authenticateToken, async (req, res, next) => {
  try {
    const campaignId = Number(req.params.id);
    const userId = req.user.user_id;

    const original = await prisma.ads_campaign.findUnique({
      where: { campaign_id: campaignId },
      include: { ads_wallet: true }
    });

    if (!original || original.ads_wallet.user_id !== userId) {
      return res.status(404).json({
        successful: false,
        message: "Original campaign not found."
      });
    }

    const cloned = await prisma.ads_campaign.create({
      data: {
        ads_wallet_id: original.ads_wallet_id,
        title: `${original.title} - Copy`,
        objective: original.objective,
        folder_tag: original.folder_tag,
        main_category: original.main_category,
        sub_category: original.sub_category,
        ad_type: original.ad_type,
        vertical: original.vertical,
        media_url: original.media_url,
        target_url: original.target_url,
        bid_type: original.bid_type,
        bid_amount: original.bid_amount,
        daily_budget: original.daily_budget,
        total_budget: original.total_budget,
        status: "DRAFT"
      }
    });

    return res.status(201).json({
      successful: true,
      data: cloned
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/status', authenticateToken, async (req, res, next) => {
  try {
    const campaignId = Number(req.params.id);
    const validated = statusToggleSchema.parse(req.body);
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

    if (validated.status === "ACTIVE") {
      const wallet = await prisma.ads_wallet.findUnique({
        where: { user_id: userId }
      });

      if (!wallet || Number(wallet.balance) <= 0) {
        return res.status(400).json({
          successful: false,
          code: "OUT_OF_BUDGET",
          message: "Cannot activate campaign with zero or negative wallet balance."
        });
      }
    }

    const updated = await prisma.ads_campaign.update({
      where: { campaign_id: campaignId },
      data: { status: validated.status }
    });

    return res.json({
      successful: true,
      data: updated
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    next(err);
  }
});

router.post('/bulk/import', authenticateToken, async (req, res, next) => {
  try {
    const validated = bulkImportSchema.parse(req.body);
    const userId = req.user.user_id;

    const adsWallet = await prisma.ads_wallet.findUnique({
      where: { user_id: userId }
    });

    if (!adsWallet) {
      return res.status(400).json({
        successful: false,
        message: "Ads wallet must be initialized first."
      });
    }

    const dataToInsert = validated.map(campaign => ({
      ads_wallet_id: adsWallet.ads_wallet_id,
      title: xss(campaign.title),
      objective: campaign.objective,
      folder_tag: campaign.folder_tag ? xss(campaign.folder_tag) : null,
      main_category: campaign.main_category,
      sub_category: xss(campaign.sub_category),
      ad_type: campaign.ad_type,
      vertical: campaign.vertical,
      media_url: campaign.media_url,
      target_url: campaign.target_url || null,
      bid_type: campaign.bid_type,
      bid_amount: campaign.bid_amount,
      daily_budget: campaign.daily_budget,
      total_budget: campaign.total_budget,
      status: "DRAFT"
    }));

    const result = await prisma.ads_campaign.createMany({
      data: dataToInsert
    });

    return res.status(201).json({
      successful: true,
      count: result.count
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    next(err);
  }
});

router.get('/bulk/export', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user.user_id;

    const adsWallet = await prisma.ads_wallet.findUnique({
      where: { user_id: userId }
    });

    if (!adsWallet) {
      return res.json({ successful: true, data: [] });
    }

    const campaigns = await prisma.ads_campaign.findMany({
      where: { ads_wallet_id: adsWallet.ads_wallet_id },
      select: {
        title: true,
        objective: true,
        folder_tag: true,
        main_category: true,
        sub_category: true,
        ad_type: true,
        vertical: true,
        media_url: true,
        target_url: true,
        bid_type: true,
        bid_amount: true,
        daily_budget: true,
        total_budget: true
      }
    });

    return res.json({
      successful: true,
      data: campaigns
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', authenticateToken, async (req, res, next) => {
  try {
    const campaignId = Number(req.params.id);
    const userId = req.user.user_id;

    const result = await prisma.$transaction(async (tx) => {
      const campaign = await tx.ads_campaign.findUnique({
        where: { campaign_id: campaignId },
        include: { ads_wallet: true }
      });

      if (!campaign || campaign.ads_wallet.user_id !== userId) {
        throw new Error('CAMPAIGN_NOT_FOUND');
      }

      const spent = Number(campaign.total_spent);
      const total = Number(campaign.total_budget);
      const refundAmount = Math.max(0, total - spent);

      if (refundAmount > 0) {
        await tx.ads_wallet.update({
          where: { user_id: userId },
          data: { balance: { increment: refundAmount } }
        });

        await tx.wallet_transaction.create({
          data: {
            user_id: userId,
            amount: refundAmount,
            type: "credit",
            source: "ad_wallet_refund",
            status: "completed",
            description: `Refund for deleted campaign #${campaignId} (${campaign.title})`
          }
        });
      }

      await tx.ads_targeting_profile.deleteMany({ where: { campaign_id: campaignId } });
      return await tx.ads_campaign.delete({ where: { campaign_id: campaignId } });
    }, { timeout: 30000 });

    try {
      const { removeCampaignFromRedis } = await import('../utils/ads-delivery-engine.js');
      await removeCampaignFromRedis(campaignId);
    } catch (redisErr) {
      console.warn('[ads-campaign] Redis offline, campaign deletion bypass in cache:', redisErr.message);
    }

    return res.json({
      successful: true,
      message: "Campaign permanently deleted and unspent budget refunded to Ads Wallet.",
      data: {
        ...result,
        file_size_bytes: result.file_size_bytes.toString()
      }
    });
  } catch (err) {
    if (err.message === 'CAMPAIGN_NOT_FOUND') {
      return res.status(404).json({ successful: false, message: "Campaign not found." });
    }
    next(err);
  }
});

export default router;