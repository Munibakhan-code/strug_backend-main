// routes/video-routes.js
import express from 'express';
import { z } from 'zod';
import multer from 'multer';
import sharp from 'sharp';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { BlobServiceClient } from '@azure/storage-blob';
import prisma from '../utils/prisma-client.js';
import redis, { isRedisReady } from '../utils/redis-client.js';
import { invalidateVideoCaches } from '../utils/video-cache.js';
import { readCachedJson, writeCachedJson } from '../utils/response-cache.js';
import { notify } from '../services/notify.js';
import logger from '../utils/logger.js';
import { authenticateToken, optionalAuth } from '../middleware/authentication.js';
import { generateVideoUploadSAS, generateVideoReadSAS, uploadVideoStream } from '../utils/azure-storage.js';
import { getQueueDepths } from '../utils/azure-queue.js';
import { enqueueVideoTask } from '../utils/video-enqueue.js';
import {
  assertVideoPipelineAcceptingUploads,
  countActiveUploads,
  maxConcurrentUploadsPerUser,
  activeUploadsKey,
} from '../utils/video-upload-capacity.js';
import { deleteAzureBlob } from '../utils/azure-cleanup.js';
import { validateMime, ALLOWED_IMAGE_TYPES, ALLOWED_VIDEO_TYPES } from '../utils/validate-mime.js';
import { selectBestAd } from '../utils/ads-delivery-engine.js';
import { profanityFilter } from '../middleware/profanity-filter.js';
import { visibleVideoWhere, visibleChannelWhere } from '../utils/video-visibility.js';
import { statusFromUploadVisibility, isOwnerOnlyVideoStatus } from '../utils/video-upload-status.js';
import { assertNoPlatformBlockBetweenUsers, blockedGraphForUser } from '../utils/platform-blocks.js';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }
});

const ALLOWED_EXTENSIONS = ['mp4', 'mov', 'mkv', 'avi', 'webm'];

const presignSchema = z.object({
  filename: z.string().min(1),
  file_size_bytes: z.number().int().positive().max(10 * 1024 * 1024 * 1024)
});

const finalizeSchema = z.object({
  raw_video_url: z.string().url(),
  title: z.string().min(3).max(255),
  description: z.string().optional().nullable(),
  category: z.string().optional().default('General'),
  video_type: z.enum(['long', 'shorts']).default('long')
});

const metadataSchema = z.object({
  title: z.string().min(3).max(255).optional(),
  description: z.string().optional().nullable(),
  category: z.string().optional()
});

const batchUploadSchema = z.object({
  videos: z.array(z.object({
    filename: z.string().min(1),
    file_size_bytes: z.number().int().positive().max(10 * 1024 * 1024 * 1024),
    title: z.string().min(3).max(255),
    description: z.string().optional().nullable(),
    category: z.string().optional().default('General'),
    video_type: z.enum(['long', 'shorts']).default('long'),
    // Capacity-only PR: temporarily disallow `private` uploads until worker/visibility pairing lands.
    // `unlisted` remains supported (it maps to pending_unlisted in statusFromUploadVisibility).
    visibility: z.enum(['public', 'unlisted']).optional().default('public')
  })).min(1).max(5)
});

function blobNameFromUrl(rawUrl) {
  // Return the blob name RELATIVE TO THE CONTAINER — i.e. everything after the first path
  // segment (the container). Chunked uploads live under a `raw/` folder
  // (videos-raw/raw/<file>), so `.pop()` (last segment only) dropped the folder and finalize's
  // exists() check + the worker queue message looked at videos-raw/<file> → "Raw video asset not
  // found in storage" on every finalize. Keep the full sub-path.
  try {
    const segments = new URL(rawUrl).pathname.split('/').filter(Boolean); // [container, ...blobPath]
    return decodeURIComponent(segments.slice(1).join('/'));
  } catch {
    return (rawUrl || '').split('/').pop() || '';
  }
}

// Videos left on the upload form's "Auto — detect" option arrive as category='auto' (legacy/empty
// uploads as '' or 'General'). The auto-categorisation sweep (workers/video-category-classifier.js)
// only picks up rows with category=null, so any of these sentinels would never get classified — the
// video would stick as uncategorised forever. Normalise them to null so the classifier fills the
// category in after transcode; an explicit pick (Music/Tech/…) is preserved verbatim.
const AUTO_CATEGORY_SENTINELS = new Set(['', 'auto', 'general']);
function normalizeCategory(c) {
  if (c == null) return null;
  const trimmed = String(c).trim();
  return AUTO_CATEGORY_SENTINELS.has(trimmed.toLowerCase()) ? null : trimmed;
}

const uploadFields = upload.fields([
  { name: 'video', maxCount: 5 },
  { name: 'thumbnail', maxCount: 5 }
]);

router.get('/play/:id', optionalAuth, async (req, res, next) => {
  try {
    // Resolve by numeric video_id OR the canonical public_id / slug so /v/{public_id}-{slug}
    // deep links (the URLs the frontend now emits) load on direct visit / share / reload.
    const idParam = String(req.params.id || '').trim();
    const isNumeric = /^\d+$/.test(idParam);
    if (!idParam) {
      return res.status(400).json({ successful: false, message: 'Invalid video ID' });
    }

    const includeBlock = {
      channel: {
        select: {
          channel_id: true,
          handle: true,
          display_name: true,
          profile_pic_url: true,
          user_id: true,
          is_active: true,
          user: {
            select: {
              social_profiles: {
                select: { is_banned: true }
              }
            }
          }
        }
      },
      _count: {
        select: { video_likes: true, video_comments: true }
      }
    };

    // These three don't depend on each other, and this route is on the critical path between a
    // tap and the first frame — running them in series cost two extra round trips per open.
    const [video, activeAds, blockedGraph] = await Promise.all([
      isNumeric
        ? prisma.video.findUnique({ where: { video_id: Number(idParam) }, include: includeBlock })
        : prisma.video.findFirst({ where: { OR: [{ public_id: idParam }, { slug: idParam }] }, include: includeBlock }),
      prisma.ads.findMany({ where: { status: 'active' }, take: 10 }),
      req.user?.user_id ? blockedGraphForUser(req.user.user_id) : Promise.resolve(null),
    ]);

    if (!video || !video.channel || !video.channel.is_active || video.channel.user?.social_profiles?.is_banned) {
      return res.status(404).json({ successful: false, message: 'Video or associated channel not found' });
    }

    if (video.status === 'banned') {
      return res.status(403).json({ successful: false, message: 'This video is unavailable' });
    }

    if (blockedGraph?.userIds.includes(Number(video.channel.user_id))) {
      return res.status(404).json({ successful: false, message: 'Video or associated channel not found' });
    }

    const isOwner = req.user?.user_id === video.channel.user_id;

    if (isOwnerOnlyVideoStatus(video.status) && !isOwner) {
      return res.status(403).json({ successful: false, message: 'This video is private' });
    }

    if (video.processing_status !== 'done' && !isOwner) {
      return res.status(404).json({ successful: false, message: 'This video is unavailable' });
    }

    const duration = video.duration_sec || 0;
    const adSchedule = [];

    if (activeAds.length > 0) {
      // The token payload carries no offset, so a two-hour video was signing the same token ~24
      // times — pure CPU on the event loop, in front of every viewer's first frame.
      const tokens = new Map();
      const adToken = (ad) => {
        if (!tokens.has(ad.ad_id)) {
          tokens.set(ad.ad_id, jwt.sign(
            { campaign_id: ad.ad_id, bid_amount: 2.50, advertiser_id: ad.advertiser_id, currency: "CAD" },
            process.env.ACCESS_TOKEN_KEY,
            { expiresIn: '1h' }
          ));
        }
        return tokens.get(ad.ad_id);
      };
      const preAd = activeAds[0];

      adSchedule.push({
        type: 'pre-roll',
        offset: 0,
        ad_id: preAd.ad_id,
        media_url: preAd.media_url,
        target_url: preAd.target_url,
        ad_token: adToken(preAd)
      });

      if (duration >= 300) {
        let adIndex = 1;
        for (let offset = 300; offset < duration - 30; offset += 300) {
          const midAd = activeAds[adIndex % activeAds.length];
          adIndex++;

          adSchedule.push({
            type: 'mid-roll',
            offset,
            ad_id: midAd.ad_id,
            media_url: midAd.media_url,
            target_url: midAd.target_url,
            ad_token: adToken(midAd)
          });
        }
      }
    }

    const containerName = process.env.AZURE_PROCESSED_VIDEO_CONTAINER || 'videos-processed';
    const isDone = video.processing_status === 'done';
    
    // 🌟 UPGRADE: Self-Healing mechanism for Absolute/Relative DB URLs
    let hlsSource = video.hls_url || (isDone ? `${video.video_id}/master.m3u8` : null);
    
    if (hlsSource && hlsSource.startsWith('http')) {
      const containerPrefix = `/${containerName}/`;
      const idx = hlsSource.indexOf(containerPrefix);
      if (idx !== -1) {
        hlsSource = hlsSource.slice(idx + containerPrefix.length);
      } else {
        const urlParts = new URL(hlsSource).pathname.split('/').filter(Boolean);
        hlsSource = urlParts.slice(1).join('/');
      }
    }

    // 🌟 UPGRADE: CDN Endpoint Resolution
    let endpoint = process.env.AZURE_STORAGE_BLOB_ENDPOINT || 'https://ststrugcaproduploads.blob.core.windows.net/';
    if (endpoint.startsWith('//')) {
      endpoint = 'https:' + endpoint;
    }

    const secureHlsUrl = hlsSource 
      ? `${endpoint.replace(/\/$/, '')}/${containerName}/${hlsSource}` 
      : null;

    return res.json({
      successful: true,
      data: {
        video_id: video.video_id,
        public_id: video.public_id,
        slug: video.slug,
        title: video.title,
        description: video.description,
        hls_url: secureHlsUrl,
        processing_status: video.processing_status,
        thumbnail_url: video.thumbnail_url ? generateVideoReadSAS(process.env.AZURE_THUMBNAIL_CONTAINER || 'thumbnails', video.thumbnail_url) : null,
        duration_sec: video.duration_sec,
        views_count: video.views_count,
        created_at: video.created_at,
        channel: {
          channel_id: video.channel.channel_id,
          display_name: video.channel.display_name,
          handle: video.channel.handle,
          profile_pic_url: video.channel.profile_pic_url
        },
        likes_count: video._count.video_likes,
        comments_count: video._count.video_comments
      },
      ad_config: {
        schedule: adSchedule
      }
    });
  } catch (err) {
    next(err);
  }
});

router.post('/upload', authenticateToken, uploadFields, async (req, res, next) => {
  try {
    await assertVideoPipelineAcceptingUploads({ getQueueDepths, logger });
    const userId = req.user.user_id;
    const channel = await prisma.channel.findUnique({ where: { user_id: userId } });
    if (!channel) {
      return res.status(404).json({ successful: false, message: 'Channel not found' });
    }

    const files = req.files;
    if (!files || !files.video || !files.video[0]) {
      return res.status(400).json({ successful: false, message: 'Video file is required' });
    }

    const videoFile = files.video[0];
    const thumbnailFile = files.thumbnail ? files.thumbnail[0] : null;

    await validateMime(videoFile.buffer, ALLOWED_VIDEO_TYPES);

    const { title, description, category, video_type, visibility: rawVisibility } = req.body;
    // Capacity-only PR: treat `private` as temporarily unsupported so it never silently becomes public.
    if (rawVisibility === 'private') {
      return res.status(400).json({ successful: false, message: 'Private visibility is temporarily unavailable.' });
    }
    const visibility = (rawVisibility === 'unlisted') ? 'unlisted' : 'public';
    if (!title || title.trim().length < 3) {
      return res.status(400).json({ successful: false, message: 'Title must be at least 3 characters' });
    }

    const rawBlobName = `raw/${userId}-${Date.now()}-${videoFile.originalname}`;
    const rawVideoUrl = await uploadVideoStream(
      process.env.AZURE_RAW_VIDEO_CONTAINER || 'videos-raw',
      rawBlobName,
      videoFile.buffer,
      videoFile.mimetype,
      { access: 'blob' }
    );

    let thumbnailUrl = null;
    let thumbnail_is_custom = false;

    if (thumbnailFile) {
      await validateMime(thumbnailFile.buffer, ALLOWED_IMAGE_TYPES);
      const optimizedThumb = await sharp(thumbnailFile.buffer).webp({ quality: 80 }).toBuffer();
      const thumbBlobName = `thumbnails/thumb-${userId}-${Date.now()}.webp`;
      thumbnailUrl = await uploadVideoStream(
        process.env.AZURE_THUMBNAIL_CONTAINER || 'thumbnails',
        thumbBlobName,
        optimizedThumb,
        'image/webp',
        { access: 'blob' }
      );
      thumbnail_is_custom = true;
    }

    const createdVideo = await prisma.$transaction(async (tx) => {
      return await tx.video.create({
        data: {
          channel_id: channel.channel_id,
          title: title.trim(),
          description: description || null,
          category: normalizeCategory(category),
          video_type: video_type || 'long',
          file_size_bytes: BigInt(videoFile.size),
          raw_video_url: rawVideoUrl,
          thumbnail_url: thumbnailUrl,
          thumbnail_is_custom,
          processing_status: 'pending',
          status: statusFromUploadVisibility(visibility)
        }
      });
    });

    await enqueueVideoTask(createdVideo.video_id, rawBlobName);

    return res.status(201).json({
      successful: true,
      data: {
        ...createdVideo,
        file_size_bytes: createdVideo.file_size_bytes.toString()
      }
    });
  } catch (err) {
    if (err?.code === 'VIDEO_PIPELINE_BUSY' || err?.status === 429) {
      return res.status(429).json({ successful: false, message: err.message, code: 'VIDEO_PIPELINE_BUSY' });
    }
    next(err);
  }
});

router.post('/presign', authenticateToken, async (req, res, next) => {
  try {
    const validated = presignSchema.parse(req.body);
    const ext = validated.filename.split('.').pop().toLowerCase();

    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return res.status(400).json({ successful: false, message: 'Invalid video file format' });
    }

    const blobName = `raw/${req.user.user_id}-${Date.now()}.${ext}`;

    const { sasUrl, blobUrl } = await generateVideoUploadSAS(
      process.env.AZURE_RAW_VIDEO_CONTAINER || 'videos-raw',
      blobName
    );

    const recommended_chunk_size_bytes = validated.file_size_bytes > 500 * 1024 * 1024
      ? 100 * 1024 * 1024
      : 10 * 1024 * 1024;

    logger.info({
      message: 'Generated pre-signed SAS upload token',
      user_id: req.user.user_id,
      blob_name: blobName,
      file_size: validated.file_size_bytes
    });

    return res.json({
      successful: true,
      data: {
        sas_url: sasUrl,
        blob_url: blobUrl,
        blob_name: blobName,
        recommended_chunk_size_bytes
      }
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    next(err);
  }
});

const feedQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.string().optional().default('12'),
  // #155: the homepage rails request distinct orderings (trending / popular / latest); the
  // feed previously ignored this so all three returned the same newest-first list.
  sort: z.enum(['latest', 'trending', 'popular']).optional().default('latest'),
  // Channel-scoped feed. The Creator Studio "Content" tab and public channel pages request
  // /video/feed?channel_id=<id>&include_shorts=true. These keys were NOT declared here, so
  // Zod silently stripped them and every channel view fell through to the GLOBAL newest-first
  // feed — which read to creators as "all the creator dashboards got merged into one" and
  // "I lost access to my own videos". category was dropped the same way (grid category chips
  // filtered nothing). channel_id carries an @@index; include_shorts lifts the long-only filter
  // so a channel shows its long videos and shorts together.
  channel_id: z.coerce.number().int().positive().optional(),
  include_shorts: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
  category: z.string().min(1).max(60).optional()
});



async function getFeedData(type, { cursorId, limitCount, sort = 'latest', channelId = null, includeShorts = false, category = null } = {}) {
  // NOTE: the /feed and /shorts callers pass an options OBJECT. This signature must destructure
  // it — a prior positional signature (type, cursorId, limitCount) turned the whole options object
  // into `cursorId`, so `Number({...})` → NaN → Prisma 500 on every feed request. Keep in lockstep
  // with release (this is the canonical, integration-tested implementation).
  const parsedLimit = parseInt(limitCount, 10) > 0 ? parseInt(limitCount, 10) : 12;
  const cacheKey = `video:feed:${type}:sort:${sort}:ch:${channelId || 'all'}:shorts:${includeShorts ? 1 : 0}:cat:${category || 'all'}:cursor:${cursorId || 'none'}:limit:${parsedLimit}`;
  const cached = await readCachedJson(cacheKey);
  if (cached) {
    return cached;
  }

  const whereCondition = visibleVideoWhere();

  // A channel view that opts into shorts wants long + shorts together, so only constrain
  // video_type outside that case (the global long rails and the /shorts endpoint still scope it).
  if (!(channelId && includeShorts)) {
    whereCondition.video_type = type;
  }
  if (channelId) whereCondition.channel_id = channelId;
  if (category) whereCondition.category = category;

  // popular = all-time most viewed; trending = most viewed among recent uploads; latest = newest.
  // Keyset cursor pagination is only meaningful for the id-ordered 'latest' feed.
  let orderBy;
  let where = whereCondition;
  if (sort === 'popular') {
    orderBy = [{ views_count: 'desc' }, { video_id: 'desc' }];
  } else if (sort === 'trending') {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    orderBy = [{ views_count: 'desc' }, { created_at: 'desc' }];
    where = { ...whereCondition, created_at: { gte: since } };
  } else {
    orderBy = { video_id: 'desc' };
    if (cursorId) where = { ...whereCondition, video_id: { lt: Number(cursorId) } };
  }

  // Fetch one extra row so clients can distinguish a full final page from a page
  // that genuinely has more content. This avoids an unnecessary empty request and
  // keeps all list surfaces bounded as the catalogue grows.
  const rows = await prisma.video.findMany({
    where,
    orderBy,
    take: parsedLimit + 1,
    select: {
      video_id: true,
      public_id: true,
      slug: true,
      title: true,
      thumbnail_url: true,
      duration_sec: true,
      views_count: true,
      video_type: true,
      created_at: true,
      channel: {
        select: {
          channel_id: true,
          user_id: true,
          display_name: true,
          handle: true,
          profile_pic_url: true,
          // Channel pages render off this embedded object; without banner_url the creator
          // header always fell back to the gradient placeholder on in-app navigation (#390).
          banner_url: true
        }
      }
    }
  });

  const hasMore = rows.length > parsedLimit;
  const list = rows.slice(0, parsedLimit);
  const canContinue = sort === 'latest' && hasMore && list.length > 0;
  const responsePayload = {
    items: list,
    has_more: canContinue,
    next_cursor: canContinue ? list[list.length - 1].video_id : null
  };

  await writeCachedJson(cacheKey, responsePayload, 120);
  return responsePayload;
}



router.post('/backfill-ladder/:video_id', authenticateToken, async (req, res, next) => {
  try {
    if (req.user?.role !== 'ADMIN' && req.user?.permission !== 'admin') {
      return res.status(403).json({ successful: false, message: 'Forbidden' });
    }

    const videoId = Number(req.params.video_id);
    if (Number.isNaN(videoId)) {
      return res.status(400).json({ successful: false, message: 'Invalid video ID' });
    }

    const video = await prisma.video.findUnique({
      where: { video_id: videoId }
    });

    if (!video) {
      return res.status(404).json({ successful: false, message: 'Video not found' });
    }

    if (!video.raw_video_url || video.raw_video_url === 'pending_upload') {
      return res.status(400).json({ successful: false, message: 'Raw video asset is not uploaded yet' });
    }

    const blobName = blobNameFromUrl(video.raw_video_url);
    if (!blobName) {
      return res.status(400).json({ successful: false, message: 'Could not resolve blob name from URL' });
    }

    await prisma.video.update({
      where: { video_id: videoId },
      data: {
        processing_status: 'pending',
        processing_attempts: 0,
        processing_error: null
      }
    });

    await enqueueVideoTask(video.video_id, blobName);

    return res.json({
      successful: true,
      message: `Successfully scheduled video #${videoId} for HLS ladder backfilling.`
    });
  } catch (err) {
    next(err);
  }
});

router.post('/backfill-ladder', authenticateToken, async (req, res, next) => {
  try {
    if (req.user?.role !== 'ADMIN' && req.user?.permission !== 'admin') {
      return res.status(403).json({ successful: false, message: 'Forbidden' });
    }

    const force = req.query.force === 'true';

    const videos = await prisma.video.findMany({
      where: {
        status: { not: 'banned' },
        raw_video_url: { not: 'pending_upload' },
        ...(force ? {} : { hls_url: null })
      }
    });

    if (videos.length === 0) {
      return res.json({ successful: true, message: 'No qualifying videos found for backfilling.' });
    }

    const scheduledIds = [];

    for (const video of videos) {
      const blobName = blobNameFromUrl(video.raw_video_url);
      if (!blobName) continue;

      await prisma.video.update({
        where: { video_id: video.video_id },
        data: {
          processing_status: 'pending',
          processing_attempts: 0,
          processing_error: null
        }
      });

      await enqueueVideoTask(video.video_id, blobName).catch(() => {});
      scheduledIds.push(video.video_id);
    }

    return res.json({
      successful: true,
      message: `Successfully scheduled ${scheduledIds.length} videos for HLS ladder backfilling.`,
      scheduled_video_ids: scheduledIds
    });
  } catch (err) {
    next(err);
  }
});







router.get('/feed', optionalAuth, async (req, res, next) => {
  try {
    const validated = feedQuerySchema.parse(req.query);
    const data = await getFeedData('long', {
      cursorId: validated.cursor,
      limitCount: validated.limit,
      sort: validated.sort,
      channelId: validated.channel_id,
      includeShorts: validated.include_shorts,
      category: validated.category
    });
    if (req.user?.user_id) {
      const blockedGraph = await blockedGraphForUser(req.user.user_id);
      if (blockedGraph.userIds.length && Array.isArray(data?.items)) {
        data.items = data.items.filter((item) => !blockedGraph.userIds.includes(Number(item.channel?.user_id)));
      }
    }
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.json({ successful: true, data });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    next(err);
  }
});

router.get('/shorts', optionalAuth, async (req, res, next) => {
  try {
    const validated = feedQuerySchema.parse(req.query);
    const data = await getFeedData('shorts', {
      cursorId: validated.cursor,
      limitCount: validated.limit,
      channelId: validated.channel_id,
      category: validated.category
    });
    if (req.user?.user_id) {
      const blockedGraph = await blockedGraphForUser(req.user.user_id);
      if (blockedGraph.userIds.length && Array.isArray(data?.items)) {
        data.items = data.items.filter((item) => !blockedGraph.userIds.includes(Number(item.channel?.user_id)));
      }
    }

    const activeAds = await prisma.ads.findMany({
      where: { status: 'active' },
      take: 3
    });

    const items = [...data.items];
    let adIndex = 0;
    const targetIndexes = [3, 8, 15];

    for (const idx of targetIndexes) {
      if (items.length > idx && activeAds.length > adIndex) {
        const ad = activeAds[adIndex];
        adIndex++;

        const ad_token = jwt.sign(
          { campaign_id: ad.ad_id, bid_amount: 0.75, advertiser_id: ad.advertiser_id, currency: "CAD" },
          process.env.ACCESS_TOKEN_KEY,
          { expiresIn: '1h' }
        );

        const sponsoredCard = {
          ad_id: ad.ad_id,
          title: ad.title,
          content_type: 'ad',
          is_sponsored: true,
          media_url: ad.media_url,
          target_url: ad.target_url,
          ad_token
        };

        items.splice(idx, 0, sponsoredCard);
      }
    }

    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.json({
      successful: true,
      data: {
        items,
        has_more: data.has_more,
        next_cursor: data.next_cursor
      }
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    next(err);
  }
});

// Accept the search term under either `query` or `q` (the frontend switched to the
// short `q` convention on 2026-06-25, which silently 400'd every search/suggest call
// that still assumed `query`). Bug #328.
const searchSchema = z.preprocess(
  (val) => {
    const v = val && typeof val === 'object' ? val : {};
    return { query: v.query ?? v.q };
  },
  z.object({ query: z.string().min(2).max(100) })
);

function highlightKeyword(text, term) {
  if (!text || !term) return text;
  const escapedTerm = term.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  const regex = new RegExp(`(${escapedTerm})`, 'gi');
  return text.replace(regex, '<strong>$1</strong>');
}

// As-you-type suggest for the two-pane search dropdown. Returns THREE things the
// frontend SearchSuggestBox renders side-by-side:
//   suggestions — phrase autocompletes (left column)
//   videos      — top matching videos for the "You might like" preview pane (right column)
//   channels    — matching creators/channels (left column, above phrases)
// The `{ suggestions, videos, channels }` envelope was dropped by the 0d1bdd9 play-endpoint
// merge (it collapsed the response to `{ data: [titleStrings] }`), which silently emptied the
// dropdown. Restored here so the frontend contract matches again. Video/channel selects mirror
// the working /feed and /search handlers; thumbnails are served from a public container (no SAS).
router.get('/suggest', async (req, res, next) => {
  try {
    const validated = searchSchema.parse(req.query);
    const sanitized = validated.query.trim();
    const lowered = sanitized.toLowerCase();
    const cacheKey = `video:suggest:${lowered}`;

    const cached = await readCachedJson(cacheKey);
    if (cached) {
      return res.json({ successful: true, ...cached });
    }

    const [phraseRows, videos, channels] = await Promise.all([
      // Left column: phrase autocompletes — video titles that start with the query.
      prisma.video.findMany({
        where: visibleVideoWhere({ title: { startsWith: lowered, mode: 'insensitive' } }),
        orderBy: { views_count: 'desc' },
        take: 8,
        select: { title: true }
      }),
      // Right column: top 3 videos matching title/description for the "You might like" pane.
      prisma.video.findMany({
        where: visibleVideoWhere({
          OR: [
            { title: { contains: sanitized, mode: 'insensitive' } },
            { description: { contains: sanitized, mode: 'insensitive' } },
            { channel: { display_name: { contains: sanitized, mode: 'insensitive' } } },
            { channel: { handle: { contains: sanitized, mode: 'insensitive' } } }
          ],
        }),
        orderBy: { views_count: 'desc' },
        take: 3,
        select: {
          video_id: true,
          public_id: true,
          slug: true,
          title: true,
          description: true,
          thumbnail_url: true,
          duration_sec: true,
          views_count: true,
          created_at: true,
          channel: {
            select: {
              channel_id: true,
              display_name: true,
              handle: true,
              profile_pic_url: true
            }
          }
        }
      }),
      // Left column (above phrases): matching creators/channels.
      prisma.channel.findMany({
        where: {
          is_active: true,
          OR: [
            { display_name: { contains: sanitized, mode: 'insensitive' } },
            { handle: { contains: sanitized, mode: 'insensitive' } }
          ]
        },
        orderBy: { subscriptions: { _count: 'desc' } },
        take: 3,
        select: { channel_id: true, display_name: true, handle: true, profile_pic_url: true }
      })
    ]);

    const payload = {
      suggestions: phraseRows.map(s => s.title),
      videos,
      channels
    };
    await writeCachedJson(cacheKey, payload, 300);

    return res.json({ successful: true, ...payload });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    next(err);
  }
});

router.get('/search', optionalAuth, async (req, res, next) => {
  try {
    const validated = searchSchema.parse(req.query);
    const sanitized = validated.query.trim();
    const cacheKey = `video:search:${sanitized.toLowerCase().replace(/\s+/g, '_')}`;

    const cached = await readCachedJson(cacheKey);
    if (cached) {
      let cachedData = cached;
      if (req.user?.user_id) {
        const blockedGraph = await blockedGraphForUser(req.user.user_id);
        cachedData = Array.isArray(cachedData)
          ? cachedData.filter((item) => !blockedGraph.userIds.includes(Number(item.channel?.user_id)))
          : cachedData;
      }
      return res.json({ successful: true, data: cachedData });
    }

    const results = await prisma.video.findMany({
      where: visibleVideoWhere({
        // Match the search term against the video's own text AND the creator's
        // channel name/handle — users search by creator name (e.g. "Aninews") and
        // expect that creator's videos back (#376/#380). The channel is_active /
        // not-banned guard from visibleVideoWhere still applies as a required AND
        // to every match.
        OR: [
          { title: { contains: sanitized, mode: 'insensitive' } },
          { description: { contains: sanitized, mode: 'insensitive' } },
          { channel: { display_name: { contains: sanitized, mode: 'insensitive' } } },
          { channel: { handle: { contains: sanitized, mode: 'insensitive' } } }
        ],
      }),
      orderBy: { views_count: 'desc' },
      take: 20,
      select: {
        video_id: true,
        public_id: true,
        slug: true,
        title: true,
        description: true,
        thumbnail_url: true,
        duration_sec: true,
        views_count: true,
        created_at: true,
        channel: {
          select: {
            channel_id: true,
            user_id: true,
            display_name: true,
            handle: true,
            profile_pic_url: true
          }
        }
      }
    });

    const blockedGraph = req.user?.user_id ? await blockedGraphForUser(req.user.user_id) : { userIds: [] };
    const highlightedResults = results
      .filter((v) => !blockedGraph.userIds.includes(Number(v.channel?.user_id)))
      .map(v => ({
        ...v,
        title: highlightKeyword(v.title, sanitized),
        description: v.description ? highlightKeyword(v.description, sanitized) : null
      }));

    logger.info({
      message: 'Active search term queried',
      query_term: sanitized,
      results_count: highlightedResults.length
    });

    await writeCachedJson(cacheKey, highlightedResults, 300);

    return res.json({ successful: true, data: highlightedResults });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    next(err);
  }
});

import { getForYou, getVideoUpNext } from '../utils/recommendation-engine.js';

const recommendQuerySchema = z.object({
  limit: z.string().optional().default('20'),
  offset: z.string().optional().default('0')
});

router.get('/home-feed', optionalAuth, async (req, res, next) => {
  try {
    const validated = feedQuerySchema.parse(req.query);
    const limit = Number(validated.limit);
    const offset = Number(validated.cursor || 0);

    const result = await getForYou({
      profileId: req.user?.profile_id || null,
      userId: req.user?.user_id || null,
      limit,
      offset,
      includeVideos: true
    });

    if (req.user?.user_id || req.user?.profile_id) {
      res.setHeader('Cache-Control', 'private, max-age=30');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=30');
    }
    return res.json({
      successful: true,
      data: {
        items: result.items,
        next_cursor: result.nextCursor,
        cold_start: result.cold
      }
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    next(err);
  }
});

router.get('/recommendations/:video_id', optionalAuth, async (req, res, next) => {
  try {
    const videoId = Number(req.params.video_id);
    if (Number.isNaN(videoId)) {
      return res.status(400).json({ successful: false, message: 'Invalid video ID' });
    }

    const validated = recommendQuerySchema.parse(req.query);
    const limit = Math.min(Math.max(Number(validated.limit) || 20, 1), 40);
    const offset = Math.max(Number(validated.offset) || 0, 0);
    const userId = req.user?.user_id || null;
    const profileId = req.user?.profile_id || null;

    const cacheKey = userId
      ? `video:recommendations:${videoId}:u:${userId}:o:${offset}:l:${limit}`
      : `video:recommendations:${videoId}:u:public:o:${offset}:l:${limit}`;

    const cached = await readCachedJson(cacheKey);
    if (cached) {
      return res.json({ successful: true, data: cached });
    }

    const currentVideo = await prisma.video.findUnique({
      where: { video_id: videoId },
      select: { video_id: true },
    });
    if (!currentVideo) {
      return res.status(404).json({ successful: false, message: 'Video not found' });
    }

    const result = await getVideoUpNext({
      videoId,
      profileId,
      userId,
      limit,
      offset,
    });

    await writeCachedJson(cacheKey, result.items, 120);

    return res.json({ successful: true, data: result.items });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    next(err);
  }
});





router.get('/watch-later', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user.user_id;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 12, 1), 50);
    const skip = Math.max(parseInt(req.query.offset) || 0, 0);

    const [watchLaterItems, total] = await Promise.all([
      prisma.video_watch_later.findMany({
        where: { user_id: userId },
        orderBy: { saved_at: 'desc' },
        take: limit,
        skip,
        include: {
          video: {
            include: {
              channel: {
                select: {
                  channel_id: true,
                  display_name: true,
                  handle: true,
                  profile_pic_url: true
                }
              }
            }
          }
        }
      }),
      prisma.video_watch_later.count({ where: { user_id: userId } })
    ]);

    const { generateVideoReadSAS } = await import('../utils/azure-storage.js');
    const containerName = process.env.AZURE_PROCESSED_VIDEO_CONTAINER || 'videos-processed';

    const mappedItems = watchLaterItems.map(item => {
      if (!item.video) return null;
      return {
        watch_later_id: item.id,
        saved_at: item.saved_at,
        video: {
          video_id: item.video.video_id,
          title: item.video.title,
          description: item.video.description,
          duration_sec: item.video.duration_sec,
          views_count: item.video.views_count,
          video_type: item.video.video_type,
          created_at: item.video.created_at,
          hls_url: generateVideoReadSAS(containerName, item.video.hls_url || `${item.video.video_id}/master.m3u8`),
          thumbnail_url: item.video.thumbnail_url ? generateVideoReadSAS(process.env.AZURE_THUMBNAIL_CONTAINER || 'thumbnails', item.video.thumbnail_url) : null,
          channel: item.video.channel
        }
      };
    }).filter(Boolean);

    return res.json({
      successful: true,
      data: {
        items: mappedItems,
        total_count: total,
        has_more: skip + limit < total
      }
    });
  } catch (err) {
    next(err);
  }
});







router.post('/:id/like', authenticateToken, async (req, res, next) => {
  try {
    const videoId = Number(req.params.id);
    if (Number.isNaN(videoId)) {
      return res.status(400).json({ successful: false, message: 'Invalid video ID' });
    }

    const userId = req.user.user_id;

    const video = await prisma.video.findUnique({
      where: { video_id: videoId },
      include: { channel: true }
    });

    if (!video || video.status === 'banned') {
      return res.status(404).json({ successful: false, message: 'Video not found' });
    }

    const existing = await prisma.video_likes.findUnique({
      where: { user_id_video_id: { user_id: userId, video_id: videoId } }
    });

    const willLike = !existing || existing.is_like !== true;
    if (willLike && video.channel?.user_id) {
      await assertNoPlatformBlockBetweenUsers(userId, video.channel.user_id);
    }

    const result = await prisma.$transaction(async (tx) => {
      if (existing) {
        if (existing.is_like === true) {
          await tx.video_likes.delete({
            where: { user_id_video_id: { user_id: userId, video_id: videoId } }
          });
          return { liked: false, disliked: false };
        } else {
          await tx.video_likes.update({
            where: { user_id_video_id: { user_id: userId, video_id: videoId } },
            data: { is_like: true }
          });
          return { liked: true, disliked: false };
        }
      } else {
        await tx.video_likes.create({
          data: { user_id: userId, video_id: videoId, is_like: true }
        });
        return { liked: true, disliked: false };
      }
    });

    if (result.liked) {
      const profile = await prisma.social_profile.findUnique({
        where: { user_id: userId },
        select: { profile_id: true }
      });
      if (profile?.profile_id) {
        const { refreshInterestProfile } = await import('../utils/recommendation-engine.js');
        refreshInterestProfile(profile.profile_id, userId).catch(() => {});
      }

      const io = req.app.get('io');
      io?.to(`user-${video.channel.user_id}`).emit('video-liked', {
        video_id: videoId,
        user_id: userId,
        liked_by: req.user.name
      });

      // #472: notify the video owner so the alert deep-links back to THIS video (not just the
      // Videos category). Skip self-likes. Best-effort — never block the like response.
      if (video.channel.user_id && video.channel.user_id !== userId) {
        notify(io, {
          userId: video.channel.user_id,
          actorUserId: userId,
          vertical: 'video',
          type: 'video.like',
          title: `${req.user.name || 'Someone'} liked your video`,
          urgency: 'ambient',
          entityType: 'video',
          entityId: videoId,
          actionUrl: 'videos',
        }).catch(() => {});
      }
    }

    return res.json({ successful: true, data: result });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/dislike', authenticateToken, async (req, res, next) => {
  try {
    const videoId = Number(req.params.id);
    if (Number.isNaN(videoId)) {
      return res.status(400).json({ successful: false, message: 'Invalid video ID' });
    }

    const userId = req.user.user_id;

    const video = await prisma.video.findUnique({
      where: { video_id: videoId },
      include: { channel: { select: { user_id: true } } }
    });

    if (!video || video.status === 'banned') {
      return res.status(404).json({ successful: false, message: 'Video not found' });
    }

    const existing = await prisma.video_likes.findUnique({
      where: { user_id_video_id: { user_id: userId, video_id: videoId } }
    });

    const willDislike = !existing || existing.is_like !== false;
    if (willDislike && video.channel?.user_id) {
      await assertNoPlatformBlockBetweenUsers(userId, video.channel.user_id);
    }

    const result = await prisma.$transaction(async (tx) => {
      if (existing) {
        if (existing.is_like === false) {
          await tx.video_likes.delete({
            where: { user_id_video_id: { user_id: userId, video_id: videoId } }
          });
          return { liked: false, disliked: false };
        } else {
          await tx.video_likes.update({
            where: { user_id_video_id: { user_id: userId, video_id: videoId } },
            data: { is_like: false }
          });
          return { liked: false, disliked: true };
        }
      } else {
        await tx.video_likes.create({
          data: { user_id: userId, video_id: videoId, is_like: false }
        });
        return { liked: false, disliked: true };
      }
    });

    return res.json({ successful: true, data: result });
  } catch (err) {
    next(err);
  }
});

// GET /video/watch-later — the saved-for-later list (the FE calls this; release had only the
// POST/DELETE toggles, so this returned 404 and the Watch Later page was broken on prod).
router.get('/watch-later', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user.user_id;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 12, 1), 50);
    const skip = Math.max(parseInt(req.query.offset) || 0, 0);

    const [watchLaterItems, total] = await Promise.all([
      prisma.video_watch_later.findMany({
        where: { user_id: userId },
        orderBy: { saved_at: 'desc' },
        take: limit,
        skip,
        include: {
          video: {
            include: {
              channel: {
                select: {
                  channel_id: true,
                  display_name: true,
                  handle: true,
                  profile_pic_url: true
                }
              }
            }
          }
        }
      }),
      prisma.video_watch_later.count({ where: { user_id: userId } })
    ]);

    const { generateVideoReadSAS } = await import('../utils/azure-storage.js');
    const containerName = process.env.AZURE_PROCESSED_VIDEO_CONTAINER || 'videos-processed';

    const mappedItems = watchLaterItems.map(item => {
      if (!item.video) return null;
      return {
        watch_later_id: item.id,
        saved_at: item.saved_at,
        video: {
          video_id: item.video.video_id,
          title: item.video.title,
          description: item.video.description,
          duration_sec: item.video.duration_sec,
          views_count: item.video.views_count,
          video_type: item.video.video_type,
          created_at: item.video.created_at,
          hls_url: generateVideoReadSAS(containerName, item.video.hls_url || `${item.video.video_id}/master.m3u8`),
          thumbnail_url: item.video.thumbnail_url ? generateVideoReadSAS(process.env.AZURE_THUMBNAIL_CONTAINER || 'thumbnails', item.video.thumbnail_url) : null,
          channel: item.video.channel
        }
      };
    }).filter(Boolean);

    return res.json({
      successful: true,
      data: {
        items: mappedItems,
        total_count: total,
        has_more: skip + limit < total
      }
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/watch-later', authenticateToken, async (req, res, next) => {
  try {
    const videoId = Number(req.params.id);
    if (Number.isNaN(videoId)) {
      return res.status(400).json({ successful: false, message: 'Invalid video ID' });
    }

    const userId = req.user.user_id;

    const video = await prisma.video.findUnique({
      where: { video_id: videoId },
      include: { channel: true }
    });

    if (!video || video.status === 'banned') {
      return res.status(404).json({ successful: false, message: 'Video not found' });
    }

    if (isOwnerOnlyVideoStatus(video.status) && video.channel.user_id !== userId) {
      return res.status(403).json({ successful: false, message: 'Forbidden: Private video cannot be saved' });
    }

    const existing = await prisma.video_watch_later.findUnique({
      where: { user_id_video_id: { user_id: userId, video_id: videoId } }
    });

    if (existing) {
      return res.json({ successful: true, saved: true, action: 'already_saved' });
    }

    const created = await prisma.video_watch_later.create({
      data: { user_id: userId, video_id: videoId }
    });

    const profile = await prisma.social_profile.findUnique({
      where: { user_id: userId },
      select: { profile_id: true }
    });
    if (profile?.profile_id) {
      const { refreshInterestProfile } = await import('../utils/recommendation-engine.js');
      refreshInterestProfile(profile.profile_id, userId).catch(() => {});
    }

    return res.json({ successful: true, saved: true, action: 'saved', data: created });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/watch-later', authenticateToken, async (req, res, next) => {
  try {
    const videoId = Number(req.params.id);
    if (Number.isNaN(videoId)) {
      return res.status(400).json({ successful: false, message: 'Invalid video ID' });
    }

    const userId = req.user.user_id;

    await prisma.video_watch_later.deleteMany({
      where: { user_id: userId, video_id: videoId }
    });

    return res.json({ successful: true, saved: false, action: 'removed' });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/finalize', authenticateToken, async (req, res, next) => {
  const videoId = Number(req.params.id);
  if (Number.isNaN(videoId)) {
    return res.status(400).json({ successful: false, message: 'Invalid video ID' });
  }

  const lockKey = `finalize:lock:${videoId}`;
  let acquired = false;

  try {
    const lockAcquired = await redis.set(lockKey, '1', 'EX', 10, 'NX');
    // A null reply means EITHER the lock is held (Redis up, NX lost) OR Redis is unavailable and
    // the client returned its no-op fallback. Only reject as "already finalizing" in the first
    // case — otherwise (no Redis, the norm on prod) proceed lock-free, or every finalize 429s and
    // uploads stay stuck at processing_status='pending' forever (#340/#342/#343).
    if (isRedisReady() && lockAcquired === null) {
      return res.status(429).json({ successful: false, message: 'Another finalization is in progress for this video' });
    }
    acquired = lockAcquired !== null;

    const validated = finalizeSchema.parse(req.body);
    const userId = req.user.user_id;

    const channel = await prisma.channel.findUnique({
      where: { user_id: userId }
    });

    if (!channel) {
      return res.status(404).json({ successful: false, message: 'Channel not found. Create a channel first.' });
    }

    const video = await prisma.video.findUnique({
      where: { video_id: videoId }
    });

    if (!video || video.channel_id !== channel.channel_id) {
      return res.status(404).json({ successful: false, message: 'Video record not found' });
    }

    if (video.processing_status !== 'pending') {
      return res.status(409).json({ successful: false, message: 'Video has already been finalized' });
    }

    const blobName = blobNameFromUrl(validated.raw_video_url);
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    const containerClient = blobServiceClient.getContainerClient(process.env.AZURE_RAW_VIDEO_CONTAINER || 'videos-raw');
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    const exists = await blockBlobClient.exists();
    if (!exists) {
      return res.status(400).json({ successful: false, message: 'Raw video asset not found in storage' });
    }

    const properties = await blockBlobClient.getProperties();
    const sizeBytes = properties.contentLength;

    if (sizeBytes > 10 * 1024 * 1024 * 1024) {
      return res.status(400).json({ successful: false, message: 'File size exceeds the 10GB limit' });
    }

    const updated = await prisma.$transaction(async (tx) => {
      return await tx.video.update({
        where: { video_id: videoId },
        data: {
          title: validated.title,
          description: validated.description,
          category: normalizeCategory(validated.category),
          video_type: validated.video_type,
          file_size_bytes: BigInt(sizeBytes),
          raw_video_url: validated.raw_video_url,
          processing_status: 'pending'
        }
      });
    });

    await enqueueVideoTask(videoId, blobName);
    try {
      await redis.srem(activeUploadsKey(userId), String(videoId));
    } catch (err) {
      logger.warn({ message: 'Could not clear active-upload slot after finalize', user_id: userId, video_id: videoId, err: err?.message });
    }

    return res.json({
      successful: true,
      data: {
        ...updated,
        file_size_bytes: updated.file_size_bytes ? updated.file_size_bytes.toString() : '0'
      }
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    next(err);
  } finally {
    if (acquired) {
      try {
        await redis.del(lockKey);
      } catch { }
    }
  }
});

router.post('/:id/thumbnail', authenticateToken, upload.single('image'), async (req, res, next) => {
  try {
    const videoId = Number(req.params.id);
    if (Number.isNaN(videoId)) {
      return res.status(400).json({ successful: false, message: 'Invalid video ID' });
    }
    if (!req.file) {
      return res.status(400).json({ successful: false, message: 'Thumbnail image file is required' });
    }

    await validateMime(req.file.buffer, ALLOWED_IMAGE_TYPES);

    const userId = req.user.user_id;
    const channel = await prisma.channel.findUnique({ where: { user_id: userId } });
    if (!channel) {
      return res.status(404).json({ successful: false, message: 'Channel not found' });
    }

    const video = await prisma.video.findUnique({ where: { video_id: videoId } });
    if (!video || video.channel_id !== channel.channel_id) {
      return res.status(404).json({ successful: false, message: 'Video not found' });
    }

    const optimizedBuffer = await sharp(req.file.buffer).webp({ quality: 80 }).toBuffer();
    const blobName = `thumbnails/thumb-${videoId}-${Date.now()}.webp`;

    const imageUrl = await uploadVideoStream(
      process.env.AZURE_THUMBNAIL_CONTAINER || 'thumbnails',
      blobName,
      optimizedBuffer,
      'image/webp',
      { access: 'blob' }
    );

    const updated = await prisma.video.update({
      where: { video_id: videoId },
      data: {
        thumbnail_url: imageUrl,
        thumbnail_is_custom: true
      }
    });

    return res.json({ successful: true, data: updated });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/metadata', authenticateToken, async (req, res, next) => {
  try {
    const videoId = Number(req.params.id);
    if (Number.isNaN(videoId)) {
      return res.status(400).json({ successful: false, message: 'Invalid video ID' });
    }

    const validated = metadataSchema.parse(req.body);
    const userId = req.user.user_id;

    const channel = await prisma.channel.findUnique({ where: { user_id: userId } });
    if (!channel) {
      return res.status(404).json({ successful: false, message: 'Channel not found' });
    }

    const video = await prisma.video.findUnique({ where: { video_id: videoId } });
    if (!video || video.channel_id !== channel.channel_id) {
      return res.status(404).json({ successful: false, message: 'Video not found' });
    }

    const updated = await prisma.video.update({
      where: { video_id: videoId },
      data: {
        title: validated.title ?? undefined,
        description: validated.description ?? undefined,
        category: validated.category === undefined ? undefined : normalizeCategory(validated.category)
      }
    });

    return res.json({ successful: true, data: updated });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    next(err);
  }
});

router.post('/bulk/upload', authenticateToken, uploadFields, async (req, res, next) => {
  try {
    await assertVideoPipelineAcceptingUploads({ getQueueDepths, logger });
    const userId = req.user.user_id;
    const channel = await prisma.channel.findUnique({ where: { user_id: userId } });
    if (!channel) {
      return res.status(404).json({ successful: false, message: 'Channel not found' });
    }

    const files = req.files;
    if (!files || !files.video || files.video.length === 0) {
      return res.status(400).json({ successful: false, message: 'Video files are required' });
    }

    const videoFiles = files.video;
    const thumbnailFiles = files.thumbnail || [];

    if (videoFiles.length > 5) {
      return res.status(400).json({ successful: false, message: 'Cannot upload more than 5 videos simultaneously' });
    }

    let metadataList = [];
    try {
      metadataList = typeof req.body.metadata === 'string' ? JSON.parse(req.body.metadata) : req.body.metadata;
    } catch {
      return res.status(400).json({ successful: false, message: 'Invalid metadata JSON format' });
    }

    if (!Array.isArray(metadataList) || metadataList.length !== videoFiles.length) {
      return res.status(400).json({ successful: false, message: 'Metadata array length must match video files count' });
    }

    const uploadSlotKey = activeUploadsKey(userId);
    const activeUploadsCount = await countActiveUploads({ redis, prisma, userId, logger });
    const cap = maxConcurrentUploadsPerUser();

    if (activeUploadsCount + videoFiles.length > cap) {
      return res.status(429).json({
        successful: false,
        code: 'UPLOAD_CONCURRENCY_LIMIT',
        message: `Maximum concurrent upload limit of ${cap} videos reached`
      });
    }

    const uploadedVideos = [];

    for (let i = 0; i < videoFiles.length; i++) {
      const videoFile = videoFiles[i];
      const thumbnailFile = thumbnailFiles[i] || null;
      const meta = metadataList[i];

      await validateMime(videoFile.buffer, ALLOWED_VIDEO_TYPES);

      if (!meta.title || meta.title.trim().length < 3) {
        throw new Error(`INVALID_TITLE_AT_INDEX_${i}`);
      }

      const rawBlobName = `raw/${userId}-${Date.now()}-${videoFile.originalname}`;
      const rawVideoUrl = await uploadVideoStream(
        process.env.AZURE_RAW_VIDEO_CONTAINER || 'videos-raw',
        rawBlobName,
        videoFile.buffer,
        videoFile.mimetype,
        { access: 'blob' }
      );

      let thumbnailUrl = null;
      let thumbnail_is_custom = false;

      if (thumbnailFile) {
        await validateMime(thumbnailFile.buffer, ALLOWED_IMAGE_TYPES);
        const optimizedThumb = await sharp(thumbnailFile.buffer).webp({ quality: 80 }).toBuffer();
        const thumbBlobName = `thumbnails/thumb-${userId}-${Date.now()}-${i}.webp`;
        thumbnailUrl = await uploadVideoStream(
          process.env.AZURE_THUMBNAIL_CONTAINER || 'thumbnails',
          thumbBlobName,
          optimizedThumb,
          'image/webp',
          { access: 'blob' }
        );
        thumbnail_is_custom = true;
      }

      const createdVideo = await prisma.$transaction(async (tx) => {
        return await tx.video.create({
          data: {
            channel_id: channel.channel_id,
            title: meta.title.trim(),
            description: meta.description || null,
            category: normalizeCategory(meta.category),
            video_type: meta.video_type || 'long',
            file_size_bytes: BigInt(videoFile.size),
            raw_video_url: rawVideoUrl,
            thumbnail_url: thumbnailUrl,
            thumbnail_is_custom,
            processing_status: 'pending',
            status: statusFromUploadVisibility(meta.visibility)
          }
        });
      });

      await enqueueVideoTask(createdVideo.video_id, rawBlobName);
      await redis.sadd(uploadSlotKey, String(createdVideo.video_id));

      uploadedVideos.push({
        ...createdVideo,
        file_size_bytes: createdVideo.file_size_bytes.toString()
      });
    }

    await redis.expire(uploadSlotKey, 86400);

    return res.status(201).json({
      successful: true,
      data: uploadedVideos
    });
  } catch (err) {
    if (err?.code === 'VIDEO_PIPELINE_BUSY' || err?.status === 429) {
      return res.status(429).json({ successful: false, message: err.message, code: 'VIDEO_PIPELINE_BUSY' });
    }
    if (err?.message?.startsWith('INVALID_TITLE_AT_INDEX_')) {
      const idx = err.message.split('_').pop();
      return res.status(400).json({ successful: false, message: `Title must be at least 3 characters at index ${idx}` });
    }
    next(err);
  }
});

router.post('/bulk/presign', authenticateToken, async (req, res, next) => {
  try {
    await assertVideoPipelineAcceptingUploads({ getQueueDepths, logger });
    const validated = batchUploadSchema.parse(req.body);
    const userId = req.user.user_id;

    const channel = await prisma.channel.findUnique({
      where: { user_id: userId }
    });

    if (!channel) {
      return res.status(404).json({ successful: false, message: 'Channel not found. Create a channel first.' });
    }

    const uploadSlotKey = activeUploadsKey(userId);
    const activeUploadsCount = await countActiveUploads({ redis, prisma, userId, logger });
    const cap = maxConcurrentUploadsPerUser();

    if (activeUploadsCount + validated.videos.length > cap) {
      return res.status(429).json({
        successful: false,
        code: 'UPLOAD_CONCURRENCY_LIMIT',
        message: `Maximum concurrent upload limit of ${cap} videos reached. Please wait for active uploads to finalize.`
      });
    }

    const responseData = await prisma.$transaction(async (tx) => {
      const updatedTasks = [];

      for (const item of validated.videos) {
        const ext = item.filename.split('.').pop().toLowerCase();
        if (!ALLOWED_EXTENSIONS.includes(ext)) {
          throw new Error('INVALID_FORMAT_IN_BATCH');
        }

        const videoRecord = await tx.video.create({
          data: {
            channel_id: channel.channel_id,
            title: item.title,
            description: item.description,
            category: normalizeCategory(item.category),
            video_type: item.video_type,
            raw_video_url: 'pending_upload',
            processing_status: 'pending',
            status: statusFromUploadVisibility(item.visibility)
          }
        });

        const blobName = `raw/${userId}-${Date.now()}-${videoRecord.video_id}.${ext}`;
        const { sasUrl, blobUrl } = await generateVideoUploadSAS(
          process.env.AZURE_RAW_VIDEO_CONTAINER || 'videos-raw',
          blobName
        );

        await redis.sadd(uploadSlotKey, String(videoRecord.video_id));

        const recommended_chunk_size_bytes = item.file_size_bytes > 500 * 1024 * 1024
          ? 100 * 1024 * 1024
          : 10 * 1024 * 1024;

        updatedTasks.push({
          video_id: videoRecord.video_id,
          title: item.title,
          sas_url: sasUrl,
          blob_url: blobUrl,
          blob_name: blobName,
          recommended_chunk_size_bytes
        });
      }

      await redis.expire(uploadSlotKey, 86400);
      return updatedTasks;
    });

    logger.info({
      message: 'Generated batch pre-signed SAS upload tokens',
      user_id: userId,
      batch_count: responseData.length
    });

    return res.json({
      successful: true,
      data: responseData
    });
  } catch (err) {
    if (err?.code === 'VIDEO_PIPELINE_BUSY' || err?.status === 429) {
      return res.status(429).json({ successful: false, message: err.message, code: 'VIDEO_PIPELINE_BUSY' });
    }
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    if (err?.message === 'INVALID_FORMAT_IN_BATCH') {
      return res.status(400).json({ successful: false, message: 'One or more files have an invalid video format' });
    }
    next(err);
  }
});

router.delete('/:id', authenticateToken, async (req, res, next) => {
  try {
    const videoId = Number(req.params.id);
    if (Number.isNaN(videoId)) {
      return res.status(400).json({ successful: false, message: 'Invalid video ID' });
    }

    const userId = req.user.user_id;
    const channel = await prisma.channel.findUnique({
      where: { user_id: userId }
    });

    if (!channel) {
      return res.status(404).json({ successful: false, message: 'Channel not found' });
    }

    const video = await prisma.video.findUnique({
      where: { video_id: videoId }
    });

    if (!video || video.channel_id !== channel.channel_id) {
      return res.status(404).json({ successful: false, message: 'Video not found' });
    }

    await prisma.$transaction(async (tx) => {
      const commentRows = await tx.video_comments.findMany({
        where: { video_id: videoId },
        select: { comment_id: true }
      });
      const commentIds = commentRows.map(c => c.comment_id);

      if (commentIds.length > 0) {
        await tx.video_comment_likes.deleteMany({
          where: { comment_id: { in: commentIds } }
        });
      }

      await tx.video_comments.deleteMany({
        where: { video_id: videoId }
      });

      await tx.video_likes.deleteMany({
        where: { video_id: videoId }
      });

      await tx.video_watch_later.deleteMany({
        where: { video_id: videoId }
      });

      await tx.playlist_item.deleteMany({
        where: { video_id: videoId }
      });

      await tx.video_analytics.deleteMany({
        where: { video_id: videoId }
      });

      await tx.watch_history.deleteMany({
        where: { video_id: videoId }
      });

      await tx.video.delete({
        where: { video_id: videoId }
      });
    }, {
      maxWait: 10000,
      timeout: 15000
    });

    // #442: the row is gone, but the feed/search/suggest/recommendation caches would keep serving
    // it for up to 5 minutes — including the channel-scoped grid the profile renders. Await this
    // (rather than fire-and-forget) so the client's refetch right after this response cannot race
    // the invalidation and re-prime the cache with the deleted video.
    await invalidateVideoCaches();

    const rawBlobName = blobNameFromUrl(video.raw_video_url);
    if (rawBlobName) {
      deleteAzureBlob(process.env.AZURE_RAW_VIDEO_CONTAINER || 'videos-raw', video.raw_video_url).catch(() => {});
    }
    if (video.thumbnail_url) {
      deleteAzureBlob(process.env.AZURE_THUMBNAIL_CONTAINER || 'thumbnails', video.thumbnail_url).catch(() => {});
    }

    return res.json({ successful: true, message: 'Video deleted successfully' });
  } catch (err) {
    next(err);
  }
});

const commentSchema = z.object({
  content: z.string().min(1).max(500),
  parent_id: z.number().int().positive().optional().nullable()
});

router.post('/:id/comments', authenticateToken, profanityFilter, async (req, res, next) => {
  try {
    const videoId = Number(req.params.id);
    if (Number.isNaN(videoId)) {
      return res.status(400).json({ successful: false, message: 'Invalid video ID' });
    }

    const validated = commentSchema.parse(req.body);
    const userId = req.user.user_id;

    const video = await prisma.video.findUnique({
      where: { video_id: videoId },
      include: { channel: { select: { user_id: true } } }
    });

    if (!video || video.status === 'banned') {
      return res.status(404).json({ successful: false, message: 'Video not found' });
    }

    if (video.channel?.user_id) {
      await assertNoPlatformBlockBetweenUsers(userId, video.channel.user_id);
    }

    if (validated.parent_id) {
      let depth = 1;
      let currentParentId = validated.parent_id;
      const directParent = await prisma.video_comments.findUnique({
        where: { comment_id: currentParentId },
        select: { video_id: true, user_id: true, parent_id: true }
      });

      if (!directParent || directParent.video_id !== videoId) {
        return res.status(400).json({ successful: false, message: 'Parent comment does not belong to this video.' });
      }

      await assertNoPlatformBlockBetweenUsers(userId, directParent.user_id);
      currentParentId = directParent.parent_id;

      while (currentParentId) {
        const parentComment = await prisma.video_comments.findUnique({
          where: { comment_id: currentParentId },
          select: { parent_id: true }
        });

        if (!parentComment) {
          break;
        }

        depth++;
        currentParentId = parentComment.parent_id;
      }

      if (depth > 3) {
        return res.status(400).json({ successful: false, message: 'Comment thread depth limit exceeded' });
      }
    }

    const created = await prisma.video_comments.create({
      data: {
        video_id: videoId,
        user_id: userId,
        parent_id: validated.parent_id || null,
        content: validated.content
      },
      include: {
        user: { select: { user_id: true, name: true, username: true } }
      }
    });

    const io = req.app.get('io');
    io?.to(`stream_${videoId}`).emit('new-comment', {
      comment_id: created.comment_id,
      video_id: videoId,
      user_id: userId,
      username: created.user.name,
      content: created.content,
      parent_id: created.parent_id
    });

    // #472: notify the video owner so the alert deep-links back to THIS video. Skip self-comments.
    // Best-effort — never block the comment response.
    if (video.channel?.user_id && video.channel.user_id !== userId) {
      notify(io, {
        userId: video.channel.user_id,
        actorUserId: userId,
        vertical: 'video',
        type: 'video.comment',
        title: `${req.user.name || 'Someone'} commented on your video`,
        urgency: 'ambient',
        entityType: 'video',
        entityId: videoId,
        actionUrl: 'videos',
      }).catch(() => {});
    }

    return res.status(201).json({ successful: true, data: created });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ successful: false, errors: (err.issues ?? err.errors) });
    }
    next(err);
  }
});

router.get('/:id/comments', optionalAuth, async (req, res, next) => {
  try {
    const videoId = Number(req.params.id);
    if (Number.isNaN(videoId)) {
      return res.status(400).json({ successful: false, message: 'Invalid video ID' });
    }

    const blockedGraph = req.user?.user_id ? await blockedGraphForUser(req.user.user_id) : { userIds: [] };
    const rawComments = await prisma.video_comments.findMany({
      where: {
        video_id: videoId,
        ...(blockedGraph.userIds.length ? { user_id: { notIn: blockedGraph.userIds } } : {}),
      },
      include: {
        // user_id is what the client compares against the logged-in user to decide whether to
        // offer "delete my comment". Without it the comment author is unidentifiable, so the
        // delete control never rendered on any comment — for anyone.
        user: { select: { user_id: true, name: true, username: true } },
        _count: { select: { comment_likes: true } }
      },
      orderBy: { created_at: 'desc' }
    });

    const commentMap = new Map();
    const roots = [];

    for (const c of rawComments) {
      commentMap.set(c.comment_id, {
        comment_id: c.comment_id,
        content: c.content,
        created_at: c.created_at,
        parent_id: c.parent_id,
        likes_count: c._count.comment_likes,
        user: c.user,
        replies: []
      });
    }

    for (const c of rawComments) {
      const mapped = commentMap.get(c.comment_id);
      if (c.parent_id) {
        const parent = commentMap.get(c.parent_id);
        if (parent) {
          parent.replies.push(mapped);
        }
      } else {
        roots.push(mapped);
      }
    }

    return res.json({ successful: true, data: roots });
  } catch (err) {
    next(err);
  }
});

router.post('/comments/:comment_id/like', authenticateToken, async (req, res, next) => {
  try {
    const commentId = Number(req.params.comment_id);
    if (Number.isNaN(commentId)) {
      return res.status(400).json({ successful: false, message: 'Invalid comment ID' });
    }

    const userId = req.user.user_id;

    const comment = await prisma.video_comments.findUnique({
      where: { comment_id: commentId },
      select: {
        user_id: true,
        video: {
          select: {
            status: true,
            channel: { select: { user_id: true } }
          }
        }
      }
    });

    if (!comment || comment.video?.status === 'banned') {
      return res.status(404).json({ successful: false, message: 'Comment not found' });
    }

    const existingLike = await prisma.video_comment_likes.findUnique({
      where: { user_id_comment_id: { user_id: userId, comment_id: commentId } }
    });

    if (existingLike) {
      await prisma.video_comment_likes.delete({
        where: { user_id_comment_id: { user_id: userId, comment_id: commentId } }
      });
      return res.json({ successful: true, liked: false });
    }

    await assertNoPlatformBlockBetweenUsers(userId, comment.user_id);
    if (comment.video?.channel?.user_id) {
      await assertNoPlatformBlockBetweenUsers(userId, comment.video.channel.user_id);
    }

    const created = await prisma.video_comment_likes.create({
      data: { user_id: userId, comment_id: commentId }
    });

    return res.json({ successful: true, liked: true, data: created });
  } catch (err) {
    next(err);
  }
});

router.delete('/comments/:comment_id', authenticateToken, async (req, res, next) => {
  try {
    const commentId = Number(req.params.comment_id);
    if (Number.isNaN(commentId)) {
      return res.status(400).json({ successful: false, message: 'Invalid comment ID' });
    }

    const userId = req.user.user_id;

    const comment = await prisma.video_comments.findUnique({
      where: { comment_id: commentId },
      include: {
        video: {
          include: { channel: true }
        }
      }
    });

    if (!comment) {
      return res.status(404).json({ successful: false, message: 'Comment not found' });
    }

    const isAuthor = comment.user_id === userId;
    const isVideoCreator = comment.video.channel.user_id === userId;
    const isAdmin = req.user.role === 'ADMIN';

    if (!isAuthor && !isVideoCreator && !isAdmin) {
      return res.status(403).json({ successful: false, message: 'Forbidden: Unauthorized comment deletion' });
    }

    await prisma.$transaction(async (tx) => {
      await tx.video_comment_likes.deleteMany({
        where: { comment_id: commentId }
      });
      await tx.video_comments.deleteMany({
        where: { parent_id: commentId }
      });
      await tx.video_comments.delete({
        where: { comment_id: commentId }
      });
    });

    return res.json({ successful: true, message: 'Comment deleted successfully' });
  } catch (err) {
    next(err);
  }
});

export default router;
