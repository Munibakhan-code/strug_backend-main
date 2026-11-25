import express from 'express';
import { z } from 'zod';
import { authenticateToken } from '../middleware/authentication.js';
import redis, { isRedisReady } from '../utils/redis-client.js';
import prisma from '../utils/prisma-client.js';
import {
  coinCatalog,
  createCoinPurchaseIntent,
  confirmCoinPurchase,
  sendGift,
  recentGifts,
  getOrCreateCoinWallet,
} from '../services/live-coins.js';

const router = express.Router();
const GIFT_RATE_LIMIT_MS = Number(process.env.LIVE_GIFT_RATE_LIMIT_MS) || 1500;

router.get('/catalog', (_req, res) => {
  res.json({ successful: true, ...coinCatalog() });
});

router.get('/balance', authenticateToken, async (req, res, next) => {
  try {
    const wallet = await getOrCreateCoinWallet(req.user.user_id);
    res.json({ successful: true, coin_balance: wallet.coin_balance });
  } catch (e) {
    if (e.code === 'P2021' || e.code === 'P2022') {
      return res.status(503).json({
        successful: false,
        message: 'Gifts are temporarily unavailable. Please try again shortly.',
        coin_balance: 0,
      });
    }
    next(e);
  }
});

const buySchema = z.object({
  pack_id: z.string().min(1),
  idempotency_key: z.string().min(8).max(255).optional(),
});

router.post('/buy', authenticateToken, async (req, res, next) => {
  try {
    const { pack_id, idempotency_key } = buySchema.parse(req.body);
    const result = await createCoinPurchaseIntent(req.user.user_id, pack_id, {
      idempotencyKey: idempotency_key || req.get('Idempotency-Key'),
    });
    res.json({
      successful: true,
      clientSecret: result.clientSecret,
      paymentIntentId: result.paymentIntentId,
      pack: result.pack,
    });
  } catch (e) {
    if (e.code === 'STRIPE_UNAVAILABLE') {
      return res.status(503).json({ successful: false, message: 'Card payments are not configured.' });
    }
    if (e.code === 'INVALID_PACK') {
      return res.status(400).json({ successful: false, message: 'Invalid coin pack.' });
    }
    next(e);
  }
});

const confirmSchema = z.object({ payment_intent_id: z.string().min(1) });

router.post('/buy/confirm', authenticateToken, async (req, res, next) => {
  try {
    const { payment_intent_id } = confirmSchema.parse(req.body);
    const result = await confirmCoinPurchase(req.user.user_id, payment_intent_id);
    res.json({ successful: true, ...result });
  } catch (e) {
    if (e.code === 'STRIPE_UNAVAILABLE') {
      return res.status(503).json({ successful: false, message: 'Card payments are not configured.' });
    }
    if (e.code === 'NOT_SUCCEEDED') {
      return res.status(409).json({ successful: false, message: e.message });
    }
    if (e.code === 'FORBIDDEN') {
      return res.status(403).json({ successful: false, message: e.message });
    }
    next(e);
  }
});

const giftSchema = z.object({
  streamer_id: z.number().int().positive(),
  gift_key: z.string().min(1),
  session_id: z.number().int().positive().optional(),
  message: z.string().max(200).optional(),
});

router.post('/gift', authenticateToken, async (req, res, next) => {
  try {
    const body = giftSchema.parse(req.body);
    // Anti-spam throttle.
    //
    // This used to be Redis-only, testing `redis.set(..., 'NX') === null` for "already sent
    // recently". utils/redis-client.js is a Proxy that RESOLVES null for every command when
    // Redis is not connected rather than throwing, so on a Redis-less prod that test was true
    // for every request and the catch below never fired: every gift 429'd and gifting was
    // entirely non-functional. isRedisReady() is what distinguishes a genuinely lost NX from a
    // silent no-op.
    //
    // The fallback deliberately hits Postgres rather than an in-process Map: this is a money
    // path, so the throttle has to survive a restart and stay correct if we ever run more than
    // one replica. We already write a live_gift row per gift, so it costs one indexed lookup.
    const rateKey = `live:gift:rl:${req.user.user_id}`;
    let rateLimited = false;
    try {
      if (isRedisReady()) {
        rateLimited = (await redis.set(rateKey, '1', 'PX', GIFT_RATE_LIMIT_MS, 'NX')) === null;
      } else {
        const recent = await prisma.live_gift.findFirst({
          where: {
            sender_user_id: req.user.user_id,
            created_at: { gte: new Date(Date.now() - GIFT_RATE_LIMIT_MS) },
          },
          select: { gift_id: true },
        });
        rateLimited = Boolean(recent);
      }
    } catch (err) {
      // Fail open: a throttle outage must not block a purchase the viewer already paid for.
      console.debug('[live-coins] gift rate-limit check failed, allowing:', err?.message);
    }
    if (rateLimited) {
      return res.status(429).json({
        successful: false,
        message: 'Please wait a moment before sending another gift.',
        code: 'GIFT_RATE_LIMIT',
        retry_after_ms: GIFT_RATE_LIMIT_MS,
      });
    }

    const result = await sendGift({
      senderUserId: req.user.user_id,
      streamerId: body.streamer_id,
      sessionId: body.session_id ?? null,
      giftKey: body.gift_key,
      message: body.message ?? null,
    });

    const io = req.app.get('io');
    if (io && result.gift) {
      const payload = {
        gift_id: result.gift.gift_id,
        gift_key: result.gift.gift_key,
        coins: result.gift.coins,
        message: result.gift.message,
        sender: result.gift.sender,
        gift_meta: result.gift_meta,
        streamer_id: result.gift.streamer_id,
        session_id: result.gift.session_id,
      };
      if (result.gift.session_id) {
        io.to(`stream_${result.gift.session_id}`).emit('live:gift', payload);
      }
    }

    res.json({ successful: true, ...result });
  } catch (e) {
    if (e.code === 'INVALID_GIFT') {
      return res.status(400).json({ successful: false, message: 'Unknown gift type.' });
    }
    if (e.code === 'STREAMER_NOT_FOUND') {
      return res.status(404).json({ successful: false, message: 'Streamer not found.' });
    }
    if (e.code === 'SELF_GIFT') {
      return res.status(400).json({ successful: false, message: 'You cannot gift yourself.' });
    }
    if (e.code === 'INSUFFICIENT_COINS') {
      return res.status(400).json({ successful: false, message: 'Insufficient coins.', code: 'INSUFFICIENT_COINS' });
    }
    if (e.code === 'P2021' || e.code === 'P2022') {
      return res.status(503).json({
        successful: false,
        message: 'Gifts are temporarily unavailable. Please try again shortly.',
      });
    }
    next(e);
  }
});

router.get('/gifts/recent', authenticateToken, async (req, res, next) => {
  try {
    const streamerId = req.query.streamer_id ? Number(req.query.streamer_id) : undefined;
    const sessionId = req.query.session_id ? Number(req.query.session_id) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const gifts = await recentGifts({ streamerId, sessionId, limit });
    res.json({ successful: true, gifts });
  } catch (e) {
    next(e);
  }
});

router.get('/gifts/leaderboard', authenticateToken, async (req, res, next) => {
  try {
    const streamerId = req.query.streamer_id != null && req.query.streamer_id !== ''
      ? Number(req.query.streamer_id)
      : null;
    const sessionId = req.query.session_id != null && req.query.session_id !== ''
      ? Number(req.query.session_id)
      : null;
    const streamerOk = streamerId != null && Number.isInteger(streamerId) && streamerId > 0;
    const sessionOk = sessionId != null && Number.isInteger(sessionId) && sessionId > 0;
    if (!streamerOk && !sessionOk) {
      return res.status(400).json({ successful: false, message: 'streamer_id or session_id required' });
    }
    const where = {};
    if (sessionOk) where.session_id = sessionId;
    if (streamerOk) where.streamer_id = streamerId;
    const grouped = await prisma.live_gift.groupBy({
      by: ['sender_user_id'],
      where,
      _sum: { coins: true },
      _count: { gift_id: true },
      orderBy: { _sum: { coins: 'desc' } },
      take: 10,
    });
    const ids = grouped.map((g) => g.sender_user_id);
    const users = ids.length
      ? await prisma.user.findMany({
        where: { user_id: { in: ids } },
        select: { user_id: true, username: true, name: true },
      })
      : [];
    const byId = Object.fromEntries(users.map((u) => [u.user_id, u]));
    const leaderboard = grouped.map((g) => ({
      user_id: g.sender_user_id,
      username: byId[g.sender_user_id]?.username || byId[g.sender_user_id]?.name || `User ${g.sender_user_id}`,
      coins: g._sum.coins || 0,
      gifts: g._count.gift_id || 0,
    }));
    res.json({ successful: true, leaderboard });
  } catch (e) {
    next(e);
  }
});

export default router;
