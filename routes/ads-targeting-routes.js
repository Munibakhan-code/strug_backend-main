import express from 'express';
import { z } from 'zod';
import axios from 'axios';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';

const router = express.Router();

const EXCHANGE_RATES_BASE_USD = {
  USD: 1.0,
  LKR: 300.0,
  CAD: 1.35
};

const targetingSchema = z.object({
  min_age: z.number().int().min(13).max(65).optional(),
  max_age: z.number().int().min(13).max(65).optional(),
  genders: z.array(z.string()).optional(),
  languages: z.array(z.string()).optional(),
  device_platforms: z.array(z.enum(['IOS', 'ANDROID', 'DESKTOP', 'MOBILE_WEB'])).optional(),
  geofence_lat: z.number().optional().nullable(),
  geofence_long: z.number().optional().nullable(),
  geofence_radius_km: z.number().positive().optional().nullable(),
  lookalike_source_id: z.number().int().positive().optional().nullable(),
  excluded_profile_ids: z.array(z.number().int()).optional(),
  connected_channel_ids: z.array(z.number().int()).optional()
});

router.post('/:campaign_id', authenticateToken, async (req, res, next) => {
  try {
    const campaignId = Number(req.params.campaign_id);
    const validated = targetingSchema.parse(req.body);
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

    const targeting = await prisma.ads_targeting_profile.upsert({
      where: { campaign_id: campaignId },
      update: validated,
      create: {
        campaign_id: campaignId,
        ...validated
      }
    });

    return res.status(201).json({
      successful: true,
      data: targeting
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    next(err);
  }
});

router.get('/:campaign_id', authenticateToken, async (req, res, next) => {
  try {
    const campaignId = Number(req.params.campaign_id);
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

    const targeting = await prisma.ads_targeting_profile.findUnique({
      where: { campaign_id: campaignId }
    });

    if (!targeting) {
      return res.status(404).json({
        successful: false,
        message: "Targeting profile not configured yet."
      });
    }

    return res.json({
      successful: true,
      data: targeting
    });
  } catch (err) {
    next(err);
  }
});

router.get('/autocomplete/search', authenticateToken, async (req, res, next) => {
  try {
    const { q } = req.query;
    if (!q || String(q).trim().length < 2) {
      return res.json({ successful: true, data: [] });
    }

    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      return res.json({
        successful: true,
        data: [
          { description: `${q}, Sri Lanka`, place_id: "mock_1" },
          { description: `${q}, Toronto, ON, Canada`, place_id: "mock_2" }
        ]
      });
    }

    const response = await axios.get(
      `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(String(q))}&key=${apiKey}`
    );

    const predictions = response.data.predictions?.map(p => ({
      description: p.description,
      place_id: p.place_id
    })) || [];

    return res.json({
      successful: true,
      data: predictions
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:campaign_id/estimate-reach', authenticateToken, async (req, res, next) => {
  try {
    const campaignId = Number(req.params.campaign_id);
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

    const targeting = await prisma.ads_targeting_profile.findUnique({
      where: { campaign_id: campaignId }
    });

    const whereClause = {
      is_seller: campaign.vertical === 'food' || campaign.vertical === 'jobs' ? true : undefined,
    };

    if (campaign.target_countries && campaign.target_countries.length > 0) {
      whereClause.country = { in: campaign.target_countries };
    }

    if (campaign.target_cities && campaign.target_cities.length > 0) {
      whereClause.city = { in: campaign.target_cities };
    }

    const totalMatchingUsers = await prisma.user.count({
      where: whereClause
    });

    const dailyBudgetUSD = convertCurrency(Number(campaign.daily_budget), campaign.ads_wallet.currency, 'USD');
    const bidAmountUSD = convertCurrency(Number(campaign.bid_amount), campaign.ads_wallet.currency, 'USD');

    const estDailyImpressions = bidAmountUSD > 0 ? Math.min(totalMatchingUsers, Math.floor(dailyBudgetUSD / bidAmountUSD)) : 0;
    const estDailyReach = Math.min(totalMatchingUsers, Math.floor(estDailyImpressions * 0.85));

    return res.json({
      successful: true,
      data: {
        potential_audience_reach: totalMatchingUsers,
        estimated_daily_impressions: estDailyImpressions,
        estimated_daily_reach: estDailyReach,
        calculated_at: new Date()
      }
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:campaign_id/lookalike', authenticateToken, async (req, res, next) => {
  try {
    const campaignId = Number(req.params.campaign_id);
    const { source_campaign_id } = req.body;
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

    const updated = await prisma.ads_targeting_profile.upsert({
      where: { campaign_id: campaignId },
      update: { lookalike_source_id: Number(source_campaign_id) },
      create: {
        campaign_id: campaignId,
        lookalike_source_id: Number(source_campaign_id)
      }
    });

    return res.json({
      successful: true,
      data: updated
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:campaign_id/connected-profiles', authenticateToken, async (req, res, next) => {
  try {
    const campaignId = Number(req.params.campaign_id);
    const { channel_ids } = req.body;
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

    const updated = await prisma.ads_targeting_profile.upsert({
      where: { campaign_id: campaignId },
      update: { connected_channel_ids: channel_ids.map(Number) },
      create: {
        campaign_id: campaignId,
        connected_channel_ids: channel_ids.map(Number)
      }
    });

    return res.json({
      successful: true,
      data: updated
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:campaign_id/exclusions', authenticateToken, async (req, res, next) => {
  try {
    const campaignId = Number(req.params.campaign_id);
    const { excluded_ids } = req.body;
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

    const updated = await prisma.ads_targeting_profile.upsert({
      where: { campaign_id: campaignId },
      update: { excluded_profile_ids: excluded_ids.map(Number) },
      create: {
        campaign_id: campaignId,
        excluded_profile_ids: excluded_ids.map(Number)
      }
    });

    return res.json({
      successful: true,
      data: updated
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:campaign_id/geofence', authenticateToken, async (req, res, next) => {
  try {
    const campaignId = Number(req.params.campaign_id);
    const { lat, long, radius_km } = req.body;
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

    const updated = await prisma.ads_targeting_profile.upsert({
      where: { campaign_id: campaignId },
      update: {
        geofence_lat: parseFloat(lat),
        geofence_long: parseFloat(long),
        geofence_radius_km: parseFloat(radius_km)
      },
      create: {
        campaign_id: campaignId,
        geofence_lat: parseFloat(lat),
        geofence_long: parseFloat(long),
        geofence_radius_km: parseFloat(radius_km)
      }
    });

    return res.json({
      successful: true,
      data: updated
    });
  } catch (err) {
    next(err);
  }
});

router.get('/system/taxonomies', authenticateToken, async (req, res, next) => {
  try {
    const ageGroups = ['13-17', '18-24', '25-34', '35-44', '45-54', '55-64', '65+'];
    const languages = ['en', 'si', 'ta', 'es', 'fr', 'de'];
    const devicePlatforms = ['IOS', 'ANDROID', 'DESKTOP', 'MOBILE_WEB'];
    const standardInterests = [
      'gaming', 'music', 'creative_arts', 'sports', 'food',
      'grocery', 'realtor', 'education', 'fashion', 'tech_hardware'
    ];

    return res.json({
      successful: true,
      data: {
        age_groups: ageGroups,
        languages,
        device_platforms: devicePlatforms,
        interests: standardInterests
      }
    });
  } catch (err) {
    next(err);
  }
});

function convertCurrency(amount, from, to) {
  if (from === to) return amount;
  const rateFrom = EXCHANGE_RATES_BASE_USD[from] || 1.0;
  const rateTo = EXCHANGE_RATES_BASE_USD[to] || 1.0;
  const amountInUSD = amount / rateFrom;
  return amountInUSD * rateTo;
}

export default router;