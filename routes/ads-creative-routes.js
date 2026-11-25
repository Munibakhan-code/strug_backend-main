import express from 'express';
import { z } from 'zod';
import xss from 'xss';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { generateVideoUploadSAS } from '../utils/azure-storage.js';
import { ALLOWED_MEDIA_TYPES } from '../utils/validate-mime.js';

const router = express.Router();

const presignSchema = z.object({
  filename: z.string().min(1),
  type: z.enum(['creatives', 'thumbnails', 'hls']).default('creatives')
});

const creativeMetadataSchema = z.object({
  headline: z.string().min(2).max(40),
  description: z.string().min(5).max(280),
  cta_text: z.enum(['ORDER_NOW', 'LEARN_MORE', 'SUBSCRIBE', 'BOOK_NOW', 'SHOP_NOW']),
  aspect_ratio: z.enum(['1:1', '16:9', '9:16'])
});

const finalizeAssetSchema = z.object({
  media_url: z.string().url(),
  file_size_bytes: z.number().int().positive(),
  duration_sec: z.number().int().nonnegative().default(0),
  mime_type: z.string()
});

const fallbackAssetSchema = z.object({
  fallback_media_url: z.string().url()
});

const validateUrlSchema = z.object({
  target_url: z.string().url()
});

const bulkAssignSchema = z.object({
  campaign_ids: z.array(z.number().int().positive()),
  headline: z.string().min(2).max(40),
  description: z.string().min(5).max(280),
  cta_text: z.enum(['ORDER_NOW', 'LEARN_MORE', 'SUBSCRIBE', 'BOOK_NOW', 'SHOP_NOW']),
  media_url: z.string().url()
});

const MALICIOUS_PATTERNS = [
  /phishing/i,
  /malware/i,
  /scam/i,
  /spamlink/i,
  /execute/i,
  /doubleclick-fraud/i
];

router.post('/presign', authenticateToken, async (req, res, next) => {
  try {
    const validated = presignSchema.parse(req.body);
    const ext = validated.filename.split('.').pop();
    const folderPrefix = validated.type;
    const blobName = `${folderPrefix}/${req.user.user_id}-${Date.now()}.${ext}`;

    const { sasUrl, blobUrl } = await generateVideoUploadSAS(
      process.env.AZURE_ADS_CONTAINER || 'social-ads',
      blobName
    );

    return res.json({
      successful: true,
      data: {
        sas_url: sasUrl,
        blob_url: blobUrl,
        blob_name: blobName
      }
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    next(err);
  }
});

router.post('/:id', authenticateToken, async (req, res, next) => {
  try {
    const campaignId = Number(req.params.id);
    const validated = creativeMetadataSchema.parse(req.body);
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

    if (campaign.ad_type === "VIDEO" && campaign.vertical === "video" && validated.aspect_ratio !== "9:16") {
      return res.status(400).json({
        successful: false,
        message: "Video shorts / Reels require a 9:16 vertical aspect ratio."
      });
    }

    const updated = await prisma.ads_campaign.update({
      where: { campaign_id: campaignId },
      data: {
        headline: xss(validated.headline),
        description: xss(validated.description),
        cta_text: validated.cta_text,
        aspect_ratio: validated.aspect_ratio
      }
    });

    return res.json({
      successful: true,
      data: {
        ...updated,
        file_size_bytes: updated.file_size_bytes ? updated.file_size_bytes.toString() : "0"
      }
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
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
      data: {
        headline: campaign.headline,
        description: campaign.description,
        cta_text: campaign.cta_text,
        aspect_ratio: campaign.aspect_ratio,
        file_size_bytes: campaign.file_size_bytes ? campaign.file_size_bytes.toString() : "0",
        duration_sec: campaign.duration_sec,
        fallback_media_url: campaign.fallback_media_url
      }
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/finalize', authenticateToken, async (req, res, next) => {
  try {
    const campaignId = Number(req.params.id);
    const validated = finalizeAssetSchema.parse(req.body);
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

    if (!ALLOWED_MEDIA_TYPES.includes(validated.mime_type)) {
      return res.status(400).json({
        successful: false,
        message: "Unsupported file MIME type."
      });
    }

    const isVideo = validated.mime_type.startsWith('video');

    if (!isVideo && validated.file_size_bytes > 5 * 1024 * 1024) {
      return res.status(400).json({
        successful: false,
        message: "Image creatives cannot exceed the 5MB file size limit."
      });
    }

    if (isVideo && validated.file_size_bytes > 100 * 1024 * 1024) {
      return res.status(400).json({
        successful: false,
        message: "Video creatives cannot exceed the 100MB file size limit."
      });
    }

    if (isVideo && validated.duration_sec > 60) {
      return res.status(400).json({
        successful: false,
        message: "Video ad duration cannot exceed 60 seconds."
      });
    }

    const updated = await prisma.ads_campaign.update({
      where: { campaign_id: campaignId },
      data: {
        media_url: validated.media_url,
        file_size_bytes: BigInt(validated.file_size_bytes),
        duration_sec: validated.duration_sec
      }
    });

    return res.json({
      successful: true,
      data: {
        ...updated,
        file_size_bytes: updated.file_size_bytes ? updated.file_size_bytes.toString() : "0"
      }
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    next(err);
  }
});

router.post('/:id/fallback', authenticateToken, async (req, res, next) => {
  try {
    const campaignId = Number(req.params.id);
    const validated = fallbackAssetSchema.parse(req.body);
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
      data: { fallback_media_url: validated.fallback_media_url }
    });

    return res.json({
      successful: true,
      data: {
        ...updated,
        file_size_bytes: updated.file_size_bytes ? updated.file_size_bytes.toString() : "0"
      }
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    next(err);
  }
});

router.post('/validate-url', authenticateToken, async (req, res, next) => {
  try {
    const validated = validateUrlSchema.parse(req.body);
    const targetUrl = validated.target_url;

    const isMalicious = MALICIOUS_PATTERNS.some(pattern => pattern.test(targetUrl));

    if (isMalicious) {
      return res.status(422).json({
        successful: false,
        code: "URL_MALICIOUS_FLAGGED",
        message: "Destination URL was flagged as unsafe or malicious."
      });
    }

    return res.json({
      successful: true,
      message: "Destination URL is safe and valid."
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    next(err);
  }
});

router.get('/:id/preview', authenticateToken, async (req, res, next) => {
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

    const previewMockHtml = `
      <div class="strug-native-ad-card" style="background:#0b1120; border:1px solid #1e293b; border-radius:12px; overflow:hidden; font-family:Arial;">
        <div style="padding:12px; display:flex; align-items:center; gap:8px;">
          <div style="width:32px; height:32px; border-radius:100px; background:#e31e24; display:flex; align-items:center; justify-content:center; color:#fff; font-weight:bold; font-size:14px;">S</div>
          <div>
            <div style="color:#fff; font-size:13px; font-weight:bold;">${campaign.title}</div>
            <div style="color:#475569; font-size:10px; font-weight:bold; text-transform:uppercase;">Sponsored</div>
          </div>
        </div>
        <div style="position:relative; width:100%; aspect-ratio:${campaign.aspect_ratio === '16:9' ? '16/9' : campaign.aspect_ratio === '9:16' ? '9/16' : '1/1'}; background:#000;">
          <img src="${campaign.media_url}" style="width:100%; height:100%; object-fit:cover;" />
        </div>
        <div style="padding:12px;">
          <div style="color:#fff; font-size:14px; font-weight:bold; margin-bottom:4px;">${campaign.headline || ''}</div>
          <div style="color:#94a3b8; font-size:12px; line-height:1.4; margin-bottom:12px;">${campaign.description || ''}</div>
          <a href="${campaign.target_url || '#'}" target="_blank" style="display:block; text-align:center; background:#e31e24; color:#fff; padding:10px; border-radius:6px; font-size:12px; font-weight:bold; text-decoration:none;">
            ${campaign.cta_text ? campaign.cta_text.replace('_', ' ') : 'LEARN MORE'}
          </a>
        </div>
      </div>
    `.trim();

    return res.json({
      successful: true,
      data: {
        campaign_id: campaignId,
        preview_html: previewMockHtml,
        layout_mode: campaign.aspect_ratio
      }
    });
  } catch (err) {
    next(err);
  }
});

router.post('/bulk/assign', authenticateToken, async (req, res, next) => {
  try {
    const validated = bulkAssignSchema.parse(req.body);
    const userId = req.user.user_id;

    const result = await prisma.$transaction(async (tx) => {
      const updatedCampaigns = [];

      for (const campaignId of validated.campaign_ids) {
        const campaign = await tx.ads_campaign.findUnique({
          where: { campaign_id: campaignId },
          include: { ads_wallet: true }
        });

        if (!campaign || campaign.ads_wallet.user_id !== userId) {
          throw new Error(`CAMPAIGN_NOT_FOUND_OR_UNAUTHORIZED_${campaignId}`);
        }

        const updated = await tx.ads_campaign.update({
          where: { campaign_id: campaignId },
          data: {
            headline: xss(validated.headline),
            description: xss(validated.description),
            cta_text: validated.cta_text,
            media_url: validated.media_url
          }
        });

        updatedCampaigns.push(updated);
      }

      return updatedCampaigns;
    }, { timeout: 30000 });

    return res.json({
      successful: true,
      assigned_count: result.length,
      data: result.map(c => ({ ...c, file_size_bytes: c.file_size_bytes.toString() }))
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    if (err.message.startsWith('CAMPAIGN_NOT_FOUND_OR_UNAUTHORIZED_')) {
      return res.status(404).json({
        successful: false,
        message: "One or more campaigns were not found or unauthorized."
      });
    }
    next(err);
  }
});

router.delete('/:id', authenticateToken, async (req, res, next) => {
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

    const updated = await prisma.ads_campaign.update({
      where: { campaign_id: campaignId },
      data: {
        headline: null,
        description: null,
        cta_text: "LEARN_MORE",
        aspect_ratio: "1:1",
        file_size_bytes: BigInt(0),
        duration_sec: 0,
        fallback_media_url: null
      }
    });

    return res.json({
      successful: true,
      message: "Creative assets cleared successfully.",
      data: {
        ...updated,
        file_size_bytes: updated.file_size_bytes.toString()
      }
    });
  } catch (err) {
    next(err);
  }
});

router.get('/system/config', authenticateToken, async (req, res, next) => {
  try {
    const allowedCtas = ['ORDER_NOW', 'LEARN_MORE', 'SUBSCRIBE', 'BOOK_NOW', 'SHOP_NOW'];
    const allowedAspectRatios = ['1:1', '16:9', '9:16'];
    const maxImageSizeBytes = 5 * 1024 * 1024;
    const maxVideoSizeBytes = 100 * 1024 * 1024;
    const maxVideoDurationSec = 60;

    return res.json({
      successful: true,
      data: {
        allowed_ctas: allowedCtas,
        allowed_aspect_ratios: allowedAspectRatios,
        max_image_size_bytes: maxImageSizeBytes,
        max_video_size_bytes: maxVideoSizeBytes,
        max_video_duration_sec: maxVideoDurationSec,
        allowed_mime_types: ALLOWED_MEDIA_TYPES
      }
    });
  } catch (err) {
    next(err);
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