import express from 'express';
import multer from 'multer';
import { z } from 'zod';
import xss from 'xss';
import crypto from 'crypto';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { uploadPublicBlob } from '../utils/azure-storage.js';
import { selectBestAd, trackAdEvent, syncCampaignToRedis } from '../utils/ads-delivery-engine.js';

BigInt.prototype.toJSON = function () { return this.toString(); };

const router = express.Router();

const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } 
});

const adCreateSchema = z.object({
  title: z.string().min(3).max(100),
  ad_type: z.enum(['IMAGE', 'VIDEO']),
  vertical: z.enum(['social', 'food', 'video', 'rental', 'jobs']),
  target_url: z.string().url().optional().nullable(),
  bid_amount: z.coerce.number().positive(),
  daily_budget: z.coerce.number().positive(),
  target_countries: z.string().optional().default("[]"),
  target_cities: z.string().optional().default("[]"),
  target_interests: z.string().optional().default("[]")
});

const fetchAdSchema = z.object({
  vertical: z.enum(['social', 'food', 'video', 'rental', 'jobs']),
  country: z.string(),
  city: z.string(),
  interests: z.array(z.string()).optional(),
  devicePlatform: z.enum(['IOS', 'ANDROID', 'DESKTOP', 'MOBILE_WEB']).default('ANDROID'),
  language: z.string().default('en')
});

const trackEventSchema = z.object({
  campaign_id: z.number().int().positive(),
  event_type: z.enum(['impression', 'click'])
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

router.post('/create', authenticateToken, upload.single('media'), async (req, res, next) => {
  try {
    const validated = adCreateSchema.parse(req.body);
    if (!req.file) {
      return res.status(400).json({ successful: false, message: "Media file is required." });
    }

    const advertiserId = req.user.user_id;
    const countries = JSON.parse(validated.target_countries);
    const cities = JSON.parse(validated.target_cities);
    const interests = JSON.parse(validated.target_interests);

    const bidFloorKey = `AD_${validated.ad_type === 'VIDEO' ? 'CPV' : 'CPC'}_FLOOR_PRICE_LKR`;
    const floorLimit = parseFloat(process.env[bidFloorKey] || "15.00");

    const wallet = await prisma.ads_wallet.findUnique({
      where: { user_id: advertiserId }
    });

    if (!wallet) {
      return res.status(400).json({ successful: false, message: "Ad Account Wallet not initialized." });
    }

    const convertedFloor = convertCurrency(floorLimit, 'LKR', wallet.currency);
    if (validated.bid_amount < convertedFloor) {
      return res.status(400).json({
        successful: false,
        message: `Bid amount is below the system floor price limit for ${validated.ad_type}.`
      });
    }

    const totalCost = validated.daily_budget * 5; 
    if (Number(wallet.balance) < totalCost) {
      return res.status(400).json({
        successful: false,
        message: `Insufficient funds in Ad Wallet. Minimum campaign budget needed: ${totalCost} ${wallet.currency}`
      });
    }

    const container = process.env.AZURE_ADS_CONTAINER || 'social-ads';
    const fileExt = req.file.originalname.split('.').pop();
    const blobName = `creatives/${advertiserId}-${Date.now()}.${fileExt}`;
    const mediaUrl = await uploadPublicBlob(container, blobName, req.file.buffer, req.file.mimetype);

    const result = await prisma.$transaction(async (tx) => {
      await tx.ads_wallet.update({
        where: { user_id: advertiserId },
        data: { balance: { decrement: totalCost } }
      });

      const timestamp = new Date();
      const txHash = generateLedgerHash({
        advertiserId,
        amount: totalCost,
        currency: wallet.currency,
        timestamp
      });

      await tx.wallet_transaction.create({
        data: {
          user_id: advertiserId,
          amount: -totalCost,
          type: "debit",
          source: "ad_campaign",
          status: "completed",
          description: `Campaign escrow fund for ${validated.title}. Hash: ${txHash}`,
          created_at: timestamp
        }
      });

      return await tx.ads_campaign.create({
        data: {
          ads_wallet_id: wallet.ads_wallet_id,
          title: xss(validated.title),
          ad_type: validated.ad_type,
          vertical: validated.vertical,
          media_url: mediaUrl,
          target_url: validated.target_url || null,
          bid_type: validated.ad_type === 'VIDEO' ? 'CPV' : 'CPC',
          bid_amount: validated.bid_amount,
          daily_budget: validated.daily_budget,
          total_budget: totalCost,
          target_countries: countries,
          target_cities: cities,
          target_interests: interests,
          status: "PENDING_REVIEW"
        }
      });
    }, { timeout: 30000 });

    await syncCampaignToRedis(result.campaign_id);

    return res.status(201).json({
      successful: true,
      message: "Ad campaign launched and submitted for review.",
      data: {
        ...result,
        file_size_bytes: result.file_size_bytes ? result.file_size_bytes.toString() : "0"
      }
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    next(err);
  }
});

router.post('/fetch-ad', authenticateToken, async (req, res, next) => {
  try {
    const validated = fetchAdSchema.parse(req.body);
    const profileId = req.user.profile_id || null;

    const selectedAd = await selectBestAd({
      vertical: validated.vertical,
      country: validated.country,
      city: validated.city,
      interests: validated.interests || [],
      devicePlatform: validated.devicePlatform,
      language: validated.language,
      profile_id: profileId
    });

    if (!selectedAd) {
      return res.json({
        successful: true,
        ad_found: false,
        message: "No active targeted ad found. Serving default system ad.",
        fallback_ad: {
          title: "Strug Premium Support",
          media_url: "https://strug.ca/logo.png",
          target_url: "https://strug.ca",
          headline: "Build. Grow. Monetize.",
          description: "Strug Super-App. Your work, time and money simplified.",
          cta_text: "LEARN_MORE"
        }
      });
    }

    return res.json({
      successful: true,
      ad_found: true,
      data: selectedAd
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      const errMsg = err.issues?.[0]?.message || err.errors?.[0]?.message || "Validation failed";
      return res.status(400).json({ successful: false, error: errMsg, errors: err.issues || err.errors });
    }
    next(err);
  }
});

router.post('/track-event', authenticateToken, async (req, res, next) => {
  try {
    const validated = trackEventSchema.parse(req.body);
    const profileId = req.user.profile_id || null;
    const ipAddress = req.ip || req.headers['x-forwarded-for'] || '127.0.0.1';
    const io = req.app.get('io');

    const processed = await trackAdEvent(
      validated.campaign_id,
      validated.event_type,
      profileId,
      ipAddress,
      io
    );

    return res.json({
      successful: true,
      event_processed: processed
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      const errMsg = err.issues?.[0]?.message || err.errors?.[0]?.message || "Validation failed";
      return res.status(400).json({ successful: false, error: errMsg, errors: err.issues || err.errors });
    }
    next(err);
  }
});

router.post('/record-impression', authenticateToken, async (req, res, next) => {
  try {
    const { ad_id } = req.body;
    const profileId = req.user.profile_id || null;
    const ipAddress = req.ip || req.headers['x-forwarded-for'] || '127.0.0.1';
    const io = req.app.get('io');

    const processed = await trackAdEvent(
      Number(ad_id),
      "impression",
      profileId,
      ipAddress,
      io
    );

    return res.json({
      successful: true,
      event_processed: processed
    });
  } catch (err) {
    next(err);
  }
});

router.post('/track-view', authenticateToken, async (req, res, next) => {
  try {
    const { ad_id } = req.body;
    const profileId = req.user.profile_id || null;
    const ipAddress = req.ip || req.headers['x-forwarded-for'] || '127.0.0.1';
    const io = req.app.get('io');

    const processed = await trackAdEvent(
      Number(ad_id),
      "impression",
      profileId,
      ipAddress,
      io
    );

    return res.json({
      successful: true,
      event_processed: processed
    });
  } catch (err) {
    next(err);
  }
});

export default router;