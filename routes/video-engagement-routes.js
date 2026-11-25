import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import prisma from '../utils/prisma-client.js';
import redis from '../utils/redis-client.js';
import { authenticateToken, optionalAuth } from '../middleware/authentication.js';
import logger from '../utils/logger.js';
import { clientIp, detectLocaleFromIp } from '../utils/locale-geo.js';
import { parseDevicePlatform } from '../utils/ad-context-harvester.js';
import { decodeCursor, pageResult, parsePageLimit } from '../utils/video-pagination.js';

const router = express.Router();

// Derive the audience signals a creator's per-video analytics need (#146): viewer country
// (geoip on the request IP) and a coarse device bucket. These columns exist on video_analytics
// but were never written, so the demographics/device panels were always empty. Best-effort —
// any failure returns nulls so a watch ping is never blocked on geo/UA parsing.
function viewerSignals(req) {
  let viewer_country = null;
  let device_type = null;
  try { viewer_country = detectLocaleFromIp(clientIp(req)).country || null; } catch { /* ignore */ }
  try {
    const platform = parseDevicePlatform(req.headers['user-agent']);
    device_type = platform === 'DESKTOP' ? 'desktop' : 'mobile';
  } catch { /* ignore */ }
  return { viewer_country, device_type };
}

// Current view total for the "already counted" response. Redis is only a best-effort read
// cache; prod has no Redis (redis-client fails open → null), so fall back to the DB, which
// is the durable source of truth for views_count.
async function currentViews(videoId) {
  const cached = await redis.get(`video:${videoId}:views`);
  if (cached !== null && cached !== undefined) return Number(cached) || 0;
  const dbVideo = await prisma.video.findUnique({
    where: { video_id: videoId },
    select: { views_count: true },
  });
  return dbVideo?.views_count || 0;
}

router.post('/:video_id/view', optionalAuth, async (req, res, next) => {
  try {
    const videoId = Number(req.params.video_id);
    if (Number.isNaN(videoId)) {
      return res.status(400).json({ successful: false, message: 'Invalid video ID' });
    }

    const userId = req.user?.user_id || null;
    const identifier = userId ? `user:${userId}` : `ip:${req.ip}`;
    const viewLockKey = `views:lock:${videoId}:${identifier}`;
    const VIEW_WINDOW_MS = 600 * 1000; // 10 min window
    const now = new Date();

    const isLocked = await redis.get(viewLockKey);
    if (isLocked) {
      return res.json({ successful: true, counted: false, views_count: await currentViews(videoId) });
    }

    const recent = await prisma.video_view.findUnique({
      where: { video_id_identifier: { video_id: videoId, identifier } },
    });
    if (recent && now.getTime() - new Date(recent.viewed_at).getTime() < VIEW_WINDOW_MS) {
      await redis.set(viewLockKey, '1', 'EX', 600);
      return res.json({ successful: true, counted: false, views_count: await currentViews(videoId) });
    }

    await prisma.video_view.upsert({
      where: { video_id_identifier: { video_id: videoId, identifier } },
      update: { viewed_at: now },
      create: { video_id: videoId, identifier, viewed_at: now },
    });
    await redis.set(viewLockKey, '1', 'EX', 600);

    // Durable view count: the DB is the source of truth (#385/#368). Increment atomically so
    // a view is never lost. Redis, when present, is only a best-effort read cache for the fast
    // path above — prod has no Redis (redis-client fails open), so the count must not depend
    // on it. (Reverts the Redis-buffered counter that never persisted views without Redis.)
    const updatedVideo = await prisma.video.update({
      where: { video_id: videoId },
      data: { views_count: { increment: 1 } },
      select: { views_count: true },
    });
    const newViewsCount = updatedVideo.views_count;
    await redis.set(`video:${videoId}:views`, newViewsCount);

    // Impression tracking is best-effort — never fail a counted view because of it, and never make
    // the viewer wait on it either: two more round trips in front of a player that is trying to
    // start. Answer first, write after.
    res.json({ successful: true, counted: true, views_count: newViewsCount });

    if (userId) {
      try {
        const profile = await prisma.social_profile.findUnique({
          where: { user_id: userId },
          select: { profile_id: true }
        });
        if (profile?.profile_id) {
          await prisma.content_impression.upsert({
            where: {
              profile_id_content_type_content_id: {
                profile_id: profile.profile_id,
                content_type: 'video',
                content_id: videoId
              }
            },
            update: { impressions: { increment: 1 } },
            create: {
              profile_id: profile.profile_id,
              content_type: 'video',
              content_id: videoId,
              impressions: 1
            }
          });
        }
      } catch (err) {
        // The response is already out, so this can only be logged — but it must be logged, or a
        // broken impression write is invisible.
        logger.warn({ message: 'Video view impression write failed', video_id: videoId, user_id: userId, error: err.message });
      }
    }

    return undefined;
  } catch (err) {
    // The counted-view response goes out before the impression write, so once it has been sent the
    // error handler must not try to send a second one.
    if (res.headersSent) {
      logger.warn({ message: 'Video view post-response work failed', video_id: req.params.video_id, error: err.message });
      return undefined;
    }
    next(err);
  }
  return undefined;
});

router.get('/history', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user.user_id;
    // Preserve the established full-history contract for analytics callers that do not opt
    // into paging. List surfaces always send a limit/cursor and receive bounded pages.
    const paginated = req.query.limit !== undefined || req.query.cursor !== undefined;
    const limit = parsePageLimit(req.query.limit);
    const cursor = decodeCursor(req.query.cursor);
    const cursorAt = cursor?.watched_at ? new Date(cursor.watched_at) : null;
    const cursorVideoId = Number(cursor?.video_id);
    if (req.query.cursor && (!cursorAt || Number.isNaN(cursorAt.getTime()) || !Number.isInteger(cursorVideoId))) {
      return res.status(400).json({ successful: false, message: 'Invalid history cursor.' });
    }
    // Match Watch Later / feed channel shape — without profile_pic_url (and channel_id) the
    // Library "Watch History" cards only show a letter avatar, even when the creator has a photo.
    const history = await prisma.watch_history.findMany({
      where: {
        user_id: userId,
        ...(cursorAt ? {
          OR: [
            { watched_at: { lt: cursorAt } },
            { watched_at: cursorAt, video_id: { lt: cursorVideoId } },
          ],
        } : {}),
      },
      include: {
        video: {
          include: {
            channel: {
              select: {
                channel_id: true,
                display_name: true,
                handle: true,
                profile_pic_url: true,
              },
            },
          },
        },
      },
      orderBy: [{ watched_at: 'desc' }, { video_id: 'desc' }],
      ...(paginated ? { take: limit + 1 } : {}),
    });

    if (!paginated) return res.json({ successful: true, data: history });
    const page = pageResult(history, limit, (row) => ({
      watched_at: row.watched_at.toISOString(),
      video_id: row.video_id,
    }));
    return res.json({ successful: true, ...page });
  } catch (err) {
    next(err);
  }
});

router.get('/:video_id/resume', authenticateToken, async (req, res, next) => {
  try {
    const videoId = Number(req.params.video_id);
    if (Number.isNaN(videoId)) {
      return res.status(400).json({ successful: false, message: 'Invalid video ID' });
    }

    const userId = req.user.user_id;
    const record = await prisma.watch_history.findUnique({
      where: { user_id_video_id: { user_id: userId, video_id: videoId } },
      select: { last_position: true }
    });

    return res.json({ successful: true, last_position: record?.last_position || 0 });
  } catch (err) {
    next(err);
  }
});

router.post('/:video_id/ping', authenticateToken, async (req, res, next) => {
  try {
    const videoId = Number(req.params.video_id);
    const { last_position } = req.body;

    if (Number.isNaN(videoId) || typeof last_position !== 'number' || last_position < 0) {
      return res.status(400).json({ successful: false, message: 'Invalid payload' });
    }

    const userId = req.user.user_id;

    // Rate-limit first (cheap, before any DB work) — one credited ping per ~9s per viewer.
    const pingLockKey = `pings:lock:${videoId}:${userId}`;
    const isLocked = await redis.get(pingLockKey);
    if (isLocked) {
      return res.status(429).json({ successful: false, message: 'Ping rate limit exceeded' });
    }
    await redis.set(pingLockKey, '1', 'EX', 9);

    // Anti-inflation guard #1 — the reported position must fit inside the video. A scripted
    // client otherwise posts an arbitrarily large offset to farm watch-time; reject anything
    // past the real duration (+2s tolerance for rounding). Durable check (no Redis dependency).
    const video = await prisma.video.findUnique({ where: { video_id: videoId }, select: { duration_sec: true } });
    if (!video) {
      return res.status(404).json({ successful: false, message: 'Video not found' });
    }
    const duration = video.duration_sec || 0;
    if (duration > 0 && last_position > duration + 2) {
      return res.status(400).json({ successful: false, message: 'Position exceeds video duration' });
    }

    // Anti-inflation guard #2 — credit only the forward progress since the previous ping,
    // capped at a plausible per-ping window (the 9s lock means legit pings advance ~10s). This
    // blocks time-inflation: you can never be credited more than the real, bounded delta, even
    // if last_position jumps. A seek backwards credits 0 but still updates the resume position.
    const PING_CREDIT_CAP_SEC = 15;
    const prev = await prisma.watch_history.findUnique({
      where: { user_id_video_id: { user_id: userId, video_id: videoId } },
      select: { last_position: true }
    });
    const prevPos = prev?.last_position ?? 0;
    const credit = Math.max(0, Math.min(Math.round(last_position - prevPos), PING_CREDIT_CAP_SEC));

    await prisma.watch_history.upsert({
      where: { user_id_video_id: { user_id: userId, video_id: videoId } },
      update: { last_position, watched_at: new Date(), credited_sec: { increment: credit } },
      create: { user_id: userId, video_id: videoId, last_position, credited_sec: credit }
    });

    const { viewer_country, device_type } = viewerSignals(req);
    await prisma.video_analytics.create({
      data: {
        video_id: videoId,
        watch_time_sec: credit,
        viewer_country,
        device_type
      }
    });

    return res.json({ successful: true, credited_sec: credit });
  } catch (err) {
    next(err);
  }
});

router.post('/:video_id/ad-view-complete', authenticateToken, async (req, res, next) => {
  try {
    const videoId = Number(req.params.video_id);
    const { ad_token } = req.body;

    if (Number.isNaN(videoId) || !ad_token) {
      return res.status(400).json({ successful: false, message: 'Invalid payload' });
    }

    const decoded = jwt.verify(ad_token, process.env.ACCESS_TOKEN_KEY);
    const { campaign_id, bid_amount, advertiser_id, currency, jti } = decoded;
    const userId = req.user.user_id;

    const creatorRatio = parseFloat(process.env.AD_CREATOR_SHARE_RATIO || '0.70');
    const costLocal = Number(bid_amount);
    const creatorShare = costLocal * creatorRatio;
    const platformShare = costLocal * (1 - creatorRatio);

    const video = await prisma.video.findUnique({
      where: { video_id: videoId },
      include: { channel: true }
    });

    if (!video || !video.channel) {
      return res.status(404).json({ successful: false, message: 'Video channel not found' });
    }

    const result = await prisma.$transaction(async (tx) => {
      // Single-use guard — consume the token's jti exactly once. A replayed ad_token hits the
      // unique PK and aborts the whole payout transaction → no double-crediting ("Ad Replay"
      // fraud). Durable (DB), so it holds even though Redis fails open. Tokens minted before
      // this shipped carry no jti; allow them through for the <=1h until they expire.
      if (jti) {
        await tx.used_ad_token.create({ data: { jti, video_id: videoId, user_id: userId } });
      }

      // Row-level lock on advertiser's wallet
      await tx.$executeRaw`SELECT * FROM "ads_wallet" WHERE "user_id" = ${advertiser_id} FOR UPDATE`;

      const wallet = await tx.ads_wallet.findUnique({
        where: { user_id: advertiser_id }
      });

      if (!wallet || Number(wallet.balance) < costLocal) {
        throw new Error('INSUFFICIENT_FUNDS_IN_LEDGER');
      }

      const receiptPayload = {
        advertiser_id,
        campaign_id,
        amount_deducted: costLocal,
        creator_share: creatorShare,
        platform_share: platformShare,
        timestamp: new Date().toISOString()
      };
      const ledgerHash = crypto.createHash('sha256').update(JSON.stringify(receiptPayload)).digest('hex');

      await tx.ads_wallet.update({
        where: { user_id: advertiser_id },
        data: { balance: { decrement: costLocal } }
      });

      // Self-Healing Upsert: Protect against legacy creator accounts lacking strug_wallets
      await tx.strug_wallet.upsert({
        where: { user_id: video.channel.user_id },
        update: { balance: { increment: creatorShare } },
        create: {
          user_id: video.channel.user_id,
          balance: creatorShare,
          currency: currency || "CAD",
          status: "active"
        }
      });

      // Self-Healing Upsert: Protect platform account strug_wallet
      await tx.strug_wallet.upsert({
        where: { user_id: 1 },
        update: { balance: { increment: platformShare } },
        create: {
          user_id: 1,
          balance: platformShare,
          currency: "CAD",
          status: "active"
        }
      });

      await tx.wallet_transaction.create({
        data: {
          user_id: advertiser_id,
          amount: -costLocal,
          type: 'debit',
          source: 'ad_campaign',
          status: 'completed',
          description: `Campaign spend debit. Receipt: ${ledgerHash}`
        }
      });

      await tx.wallet_transaction.create({
        data: {
          user_id: video.channel.user_id,
          amount: creatorShare,
          type: 'credit',
          source: 'ad_revenue',
          status: 'completed',
          description: `Video creator payout share (70%). Receipt: ${ledgerHash}`
        }
      });

      await tx.wallet_transaction.create({
        data: {
          user_id: 1,
          amount: platformShare,
          type: 'credit',
          source: 'live_ad_tax',
          status: 'completed',
          description: `Video platform tax share (30%). Receipt: ${ledgerHash}`
        }
      });

      return { ledgerHash };
    });

    return res.json({ successful: true, receipt: result.ledgerHash });
  } catch (err) {
    // Replayed token — the jti was already consumed by an earlier credited view.
    if (err?.code === 'P2002') {
      return res.status(409).json({ successful: false, message: 'Ad view already credited' });
    }
    if (err?.message === 'INSUFFICIENT_FUNDS_IN_LEDGER') {
      return res.status(402).json({ successful: false, message: 'Advertiser balance insufficient' });
    }
    next(err);
  }
});

export default router;
