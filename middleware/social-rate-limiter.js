// middleware/social-rate-limiter.js
import prisma from '../utils/prisma-client.js';
import redis from '../utils/redis-client.js';

const POST_LIMIT_WINDOW_SEC = 60;
const MAX_POSTS_PER_WINDOW = 3;
const ENGAGE_LIMIT_WINDOW_SEC = 60;
const MAX_ENGAGE_PER_WINDOW = 60;
const UPLOAD_LIMIT_WINDOW_SEC = 60;
const MAX_UPLOADS_PER_WINDOW = 5;

/** Process-local fallback when Redis is unavailable (dev / Redis outage). */
const memoryBuckets = new Map();

function memoryRateLimit(cacheKey, windowSec, max) {
  const now = Date.now();
  const windowMs = windowSec * 1000;
  let bucket = memoryBuckets.get(cacheKey);
  if (!bucket || now - bucket.startedAt >= windowMs) {
    bucket = { startedAt: now, count: 0 };
    memoryBuckets.set(cacheKey, bucket);
  }
  bucket.count += 1;
  if (bucket.count > max) {
    const ttl = Math.ceil((windowMs - (now - bucket.startedAt)) / 1000);
    return { limited: true, ttl: ttl > 0 ? ttl : windowSec };
  }
  return { limited: false };
}

async function redisRateLimit(cacheKey, windowSec, max) {
  if (!redis || redis.status !== 'ready') return null;
  const current = await redis.incr(cacheKey);
  if (current === 1) await redis.expire(cacheKey, windowSec);
  if (current > max) {
    const ttl = await redis.ttl(cacheKey);
    return { limited: true, ttl: ttl > 0 ? ttl : windowSec };
  }
  return { limited: false };
}

function makePostLimiter({ redisKeyPrefix, countRecent }) {
  return async (req, res, next) => {
    const userId = req.user?.user_id;
    if (!userId) return next();

    const cacheKey = `${redisKeyPrefix}:${userId}`;

    try {
      const redisResult = await redisRateLimit(cacheKey, POST_LIMIT_WINDOW_SEC, MAX_POSTS_PER_WINDOW);
      if (redisResult) {
        if (redisResult.limited) {
          return res.status(429).json({
            successful: false,
            message: `Too many posts! Please wait ${redisResult.ttl} seconds before sharing again.`,
          });
        }
        return next();
      }
    } catch (redisErr) {
      console.warn('[social-rate-limiter] Redis offline, falling back to DB:', redisErr.message);
    }

    try {
      const postCount = await countRecent(userId);
      if (postCount >= MAX_POSTS_PER_WINDOW) {
        return res.status(429).json({
          successful: false,
          message: 'Too many posts! Please wait a moment before sharing again.',
        });
      }
    } catch (dbErr) {
      // Fail closed: never allow unlimited posting when both Redis and DB checks fail.
      console.error('[social-rate-limiter] Critical fallback failed:', dbErr.message);
      return res.status(503).json({
        successful: false,
        message: 'Rate limiting temporarily unavailable. Please try again shortly.',
      });
    }

    next();
  };
}

/** Town Hall create — counts town_hall_post rows. */
export const socialRateLimiter = makePostLimiter({
  redisKeyPrefix: 'rate:townhall:user',
  countRecent: async (userId) => {
    const oneMinuteAgo = new Date(Date.now() - POST_LIMIT_WINDOW_SEC * 1000);
    return prisma.town_hall_post.count({
      where: { user_id: userId, created_at: { gte: oneMinuteAgo } },
    });
  },
});

/** Instagram-style social-post create — separate bucket from Town Hall. */
export const socialPostRateLimiter = makePostLimiter({
  redisKeyPrefix: 'rate:social-post:user',
  countRecent: async (userId) => {
    const oneMinuteAgo = new Date(Date.now() - POST_LIMIT_WINDOW_SEC * 1000);
    const profile = await prisma.social_profile.findUnique({
      where: { user_id: userId },
      select: { profile_id: true },
    });
    if (!profile) return 0;
    return prisma.social_feed.count({
      where: { profile_id: profile.profile_id, created_at: { gte: oneMinuteAgo } },
    });
  },
});

/** Like / repost / save / vote — soft throttle to curb abuse. Memory fallback if Redis down. */
export const engagementRateLimiter = async (req, res, next) => {
  const userId = req.user?.user_id;
  if (!userId) return next();

  const cacheKey = `rate:engage:user:${userId}`;
  try {
    const redisResult = await redisRateLimit(cacheKey, ENGAGE_LIMIT_WINDOW_SEC, MAX_ENGAGE_PER_WINDOW);
    if (redisResult?.limited) {
      return res.status(429).json({
        successful: false,
        message: `Too many actions. Please wait ${redisResult.ttl} seconds.`,
      });
    }
    if (redisResult) return next();
  } catch (err) {
    console.warn('[engagement-rate-limiter] Redis skip:', err.message);
  }
  const mem = memoryRateLimit(cacheKey, ENGAGE_LIMIT_WINDOW_SEC, MAX_ENGAGE_PER_WINDOW);
  if (mem.limited) {
    return res.status(429).json({
      successful: false,
      message: `Too many actions. Please wait ${mem.ttl} seconds.`,
    });
  }
  next();
};

/** Media upload throttle (Town Hall + social). Memory fallback if Redis down. */
export const uploadRateLimiter = async (req, res, next) => {
  const userId = req.user?.user_id;
  if (!userId) return next();

  const cacheKey = `rate:upload:user:${userId}`;
  try {
    const redisResult = await redisRateLimit(cacheKey, UPLOAD_LIMIT_WINDOW_SEC, MAX_UPLOADS_PER_WINDOW);
    if (redisResult?.limited) {
      return res.status(429).json({
        successful: false,
        message: `Too many uploads. Please wait ${redisResult.ttl} seconds.`,
      });
    }
    if (redisResult) return next();
  } catch (err) {
    console.warn('[upload-rate-limiter] Redis skip:', err.message);
  }
  const mem = memoryRateLimit(cacheKey, UPLOAD_LIMIT_WINDOW_SEC, MAX_UPLOADS_PER_WINDOW);
  if (mem.limited) {
    return res.status(429).json({
      successful: false,
      message: `Too many uploads. Please wait ${mem.ttl} seconds.`,
    });
  }
  next();
};
