import express from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma-client.js';
import { clientErrorMessage } from '../utils/client-error.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

const biddingSchema = z.object({
  bid_type: z.enum(['CPC', 'CPM', 'CPV']),
  bid_amount: z.number().positive(),
  placements: z.array(z.string()).nonempty(),
  frequency_cap: z.number().int().positive().default(3)
});

const daypartingSchema = z.object({
  schedule: z.record(z.string(), z.array(z.number().int().min(0).max(23)))
});

const budgetScaleSchema = z.object({
  daily_budget: z.number().positive().optional(),
  bid_amount: z.number().positive().optional()
});

const pacingSchema = z.object({
  pacing_mode: z.enum(['STANDARD', 'ACCELERATED'])
});

const bulkBiddingSchema = z.array(z.object({
  campaign_id: z.number().int().positive(),
  bid_amount: z.number().positive().optional(),
  daily_budget: z.number().positive().optional()
}));

router.put('/:id', authenticateToken, async (req, res, next) => {
  try {
    const campaignId = Number(req.params.id);
    const validated = biddingSchema.parse(req.body);
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

    const floorKey = `AD_${validated.bid_type}_FLOOR_PRICE_LKR`;
    const floorLimit = parseFloat(process.env[floorKey] || "15.00");

    if (validated.bid_amount < convertCurrency(floorLimit, 'LKR', campaign.ads_wallet.currency)) {
      return res.status(400).json({
        successful: false,
        message: `Bid amount is below the system floor price limit for ${validated.bid_type}.`
      });
    }

    const updated = await prisma.ads_campaign.update({
      where: { campaign_id: campaignId },
      data: {
        bid_type: validated.bid_type,
        bid_amount: validated.bid_amount,
        placements: validated.placements,
        frequency_cap: validated.frequency_cap
      }
    });

    return res.json({
      successful: true,
      data: updated
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      const errMsg = err.issues?.[0]?.message || err.errors?.[0]?.message || "Validation failed";
      return res.status(400).json({ successful: false, error: errMsg, errors: err.issues || err.errors });
    }
    return res.status(500).json({ successful: false, error: clientErrorMessage(err) });
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
      data: {
        bid_type: campaign.bid_type,
        bid_amount: campaign.bid_amount,
        placements: campaign.placements,
        frequency_cap: campaign.frequency_cap,
        pacing_mode: campaign.pacing_mode
      }
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/dayparting', authenticateToken, async (req, res, next) => {
  try {
    const campaignId = Number(req.params.id);
    const validated = daypartingSchema.parse(req.body);
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

    const updated = await prisma.ads_campaign.update({
      where: { campaign_id: campaignId },
      data: { dayparting_schedule: validated.schedule }
    });

    return res.status(201).json({
      successful: true,
      data: updated
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      const errMsg = err.issues?.[0]?.message || err.errors?.[0]?.message || "Validation failed";
      return res.status(400).json({ successful: false, error: errMsg, errors: err.issues || err.errors });
    }
    return res.status(500).json({ successful: false, error: clientErrorMessage(err) });
  }
});

router.get('/:id/dayparting', authenticateToken, async (req, res, next) => {
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
      data: campaign.dayparting_schedule
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/overlap', authenticateToken, async (req, res, next) => {
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

    const overlappingCampaigns = await prisma.ads_campaign.findMany({
      where: {
        ads_wallet_id: campaign.ads_wallet_id,
        campaign_id: { not: campaignId },
        status: "ACTIVE",
        target_countries: { hasSome: campaign.target_countries },
        target_cities: { hasSome: campaign.target_cities }
      },
      select: {
        campaign_id: true,
        title: true,
        target_interests: true
      }
    });

    const overlapDetails = overlappingCampaigns.map(c => {
      const intersection = c.target_interests.filter(i => campaign.target_interests.includes(i));
      const overlapPct = campaign.target_interests.length > 0 
        ? (intersection.length / campaign.target_interests.length) * 100 
        : 0;

      return {
        campaign_id: c.campaign_id,
        title: c.title,
        overlap_percentage: parseFloat(overlapPct.toFixed(1))
      };
    });

    return res.json({
      successful: true,
      data: overlapDetails
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/scale-budget', authenticateToken, async (req, res, next) => {
  try {
    const campaignId = Number(req.params.id);
    const validated = budgetScaleSchema.parse(req.body);
    const userId = req.user.user_id;

    const result = await prisma.$transaction(async (tx) => {
      const campaign = await tx.ads_campaign.findUnique({
        where: { campaign_id: campaignId },
        include: { ads_wallet: true }
      });

      if (!campaign || campaign.ads_wallet.user_id !== userId) {
        throw new Error('CAMPAIGN_NOT_FOUND');
      }

      const updatedDailyBudget = validated.daily_budget ? Number(validated.daily_budget) : Number(campaign.daily_budget);
      const updatedBidAmount = validated.bid_amount ? Number(validated.bid_amount) : Number(campaign.bid_amount);

      let newStatus = campaign.status;
      if (Number(campaign.spent_today) >= updatedDailyBudget) {
        newStatus = "OUT_OF_BUDGET";
      } else if (campaign.status === "OUT_OF_BUDGET" && Number(campaign.spent_today) < updatedDailyBudget) {
        newStatus = "ACTIVE";
      }

      return await tx.ads_campaign.update({
        where: { campaign_id: campaignId },
        data: {
          daily_budget: updatedDailyBudget,
          bid_amount: updatedBidAmount,
          status: newStatus
        }
      });
    }, { timeout: 30000 });

    return res.json({
      successful: true,
      data: result
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      const errMsg = err.issues?.[0]?.message || err.errors?.[0]?.message || "Validation failed";
      return res.status(400).json({ successful: false, error: errMsg, errors: err.issues || err.errors });
    }
    return res.status(500).json({ successful: false, error: clientErrorMessage(err) });
  }
});

router.get('/system/floors', authenticateToken, async (req, res, next) => {
  try {
    const cpmFloor = parseFloat(process.env.AD_CPM_FLOOR_PRICE_LKR || "150.00");
    const cpcFloor = parseFloat(process.env.AD_CPC_FLOOR_PRICE_LKR || "15.00");
    const cpvFloor = parseFloat(process.env.AD_CPV_FLOOR_PRICE_LKR || "5.00");

    return res.json({
      successful: true,
      data: {
        floor_prices: {
          CPM: cpmFloor,
          CPC: cpcFloor,
          CPV: cpvFloor
        },
        currency: "LKR"
      }
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/pacing-mode', authenticateToken, async (req, res, next) => {
  try {
    const campaignId = Number(req.params.id);
    const validated = pacingSchema.parse(req.body);
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

    const updated = await prisma.ads_campaign.update({
      where: { campaign_id: campaignId },
      data: { pacing_mode: validated.pacing_mode }
    });

    return res.json({
      successful: true,
      data: updated
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      const errMsg = err.issues?.[0]?.message || err.errors?.[0]?.message || "Validation failed";
      return res.status(400).json({ successful: false, error: errMsg, errors: err.issues || err.errors });
    }
    return res.status(500).json({ successful: false, error: clientErrorMessage(err) });
  }
});

router.get('/:id/recommendation', authenticateToken, async (req, res, next) => {
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

    const currentBid = Number(campaign.bid_amount);
    const recommendedBid = currentBid * 1.15; 

    return res.json({
      successful: true,
      data: {
        campaign_id: campaignId,
        current_bid: currentBid,
        recommended_bid: parseFloat(recommendedBid.toFixed(2)),
        reason: "Increase bid by 15% to win more ad auctions in your target geo.",
        currency: campaign.ads_wallet.currency
      }
    });
  } catch (err) {
    next(err);
  }
});

router.post('/bulk/update', authenticateToken, async (req, res, next) => {
  try {
    const validated = bulkBiddingSchema.parse(req.body);
    const userId = req.user.user_id;

    const result = await prisma.$transaction(async (tx) => {
      const updatedCampaigns = [];

      for (const item of validated) {
        const campaign = await tx.ads_campaign.findUnique({
          where: { campaign_id: item.campaign_id },
          include: { ads_wallet: true }
        });

        if (!campaign || campaign.ads_wallet.user_id !== userId) {
          throw new Error(`CAMPAIGN_NOT_FOUND_OR_UNAUTHORIZED_${item.campaign_id}`);
        }

        const updated = await tx.ads_campaign.update({
          where: { campaign_id: item.campaign_id },
          data: {
            bid_amount: item.bid_amount ? Number(item.bid_amount) : undefined,
            daily_budget: item.daily_budget ? Number(item.daily_budget) : undefined
          }
        });

        updatedCampaigns.push(updated);
      }

      return updatedCampaigns;
    }, { timeout: 30000 });

    return res.json({
      successful: true,
      updated_count: result.length,
      data: result
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      const errMsg = err.issues?.[0]?.message || err.errors?.[0]?.message || "Validation failed";
      return res.status(400).json({ successful: false, error: errMsg, errors: err.issues || err.errors });
    }
    return res.status(500).json({ successful: false, error: clientErrorMessage(err) });
  }
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

export default router;