/**
 * Public + authenticated platform helpers for profile sidebar widgets.
 * Counts and curated content live here so the SPA is not a marketing mock.
 */
import express from 'express';
import prisma from '../utils/prisma-client.js';
import { buildPlatformTips } from '../utils/platform-today-tips.js';
import { authenticateToken, optionalAuth } from '../middleware/authentication.js';
import {
  PROFILE_POLL,
  PROFILE_CURATED_BOOKS,
  DEFAULT_WEATHER_LOCATION,
  buildProfileContentPayload,
  dayOfYearUTC,
  mapCatalogBook,
  mapCuratedBook,
  pickByDay,
  weatherCodeLabel,
} from '../utils/platform-profile-content.js';

const router = express.Router();

const SIDEBAR_ENTITY = 'profile_sidebar';
const SIDEBAR_ID = 'me';
const POLL_ENTITY = 'profile_poll';

function startOfUtcDay(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * GET /platform/today
 * Public (no auth). Coarse platform pulse for profile sidebar widgets.
 */
router.get('/today', async (_req, res, next) => {
  try {
    const since = startOfUtcDay();

    const [sellerRows, ordersToday, liveStreams, videosWatchedToday] = await Promise.all([
      // Match public shop browse (#348): hide sellers with an explicitly deactivated store.
      prisma.product_listing.findMany({
        where: {
          seller_id: { not: null },
          seller: {
            OR: [
              { storeProfile: { is: null } },
              { storeProfile: { is_active: true } },
            ],
          },
        },
        distinct: ['seller_id'],
        select: { seller_id: true },
      }),
      prisma.product_order.count({
        where: {
          ispaid: true,
          order_time: { gte: since },
        },
      }),
      prisma.live_session.count({ where: { status: 'LIVE' } }),
      prisma.video_view.count({ where: { viewed_at: { gte: since } } }),
    ]);

    const activeSellers = sellerRows.length;
    const stats = {
      active_sellers: activeSellers,
      orders_today: ordersToday,
      live_streams: liveStreams,
      videos_watched_today: videosWatchedToday,
      as_of: new Date().toISOString(),
    };

    res.json({
      successful: true,
      data: {
        ...stats,
        tips: buildPlatformTips(stats),
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /platform/profile-content
 * Public curated sidebar copy (What's New, quotes, news, spotlight, spin, poll shape, goals).
 */
router.get('/profile-content', (_req, res) => {
  res.json({ successful: true, data: buildProfileContentPayload() });
});

/**
 * GET /platform/book-of-day
 * Prefers a real Books catalog row; falls back to curated picks (still savable via /saves book).
 */
router.get('/book-of-day', async (_req, res, next) => {
  try {
    const rows = await prisma.dg_content.findMany({
      where: {
        dg_categories: {
          dg_category_name: { equals: 'Books', mode: 'insensitive' },
        },
      },
      orderBy: { content_id: 'asc' },
      take: 64,
      select: {
        content_id: true,
        content_title: true,
        author: true,
        content_description: true,
        cover_img_url: true,
      },
    });

    const now = new Date();
    if (rows.length > 0) {
      const idx = dayOfYearUTC(now) % rows.length;
      return res.json({
        successful: true,
        data: mapCatalogBook(rows[idx], idx),
      });
    }

    const curated = mapCuratedBook(pickByDay(PROFILE_CURATED_BOOKS, now));
    return res.json({ successful: true, data: curated });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /platform/weather
 * Proxies Open-Meteo (no API key). Optional ?lat=&lon=&city=
 */
router.get('/weather', async (req, res, next) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    const city = typeof req.query.city === 'string' && req.query.city.trim()
      ? req.query.city.trim().slice(0, 80)
      : DEFAULT_WEATHER_LOCATION.city;
    const latitude = Number.isFinite(lat) ? lat : DEFAULT_WEATHER_LOCATION.latitude;
    const longitude = Number.isFinite(lon) ? lon : DEFAULT_WEATHER_LOCATION.longitude;

    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return res.status(400).json({ successful: false, message: 'Invalid coordinates' });
    }

    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', String(latitude));
    url.searchParams.set('longitude', String(longitude));
    url.searchParams.set('current', 'temperature_2m,weather_code');
    url.searchParams.set('timezone', 'auto');

    const upstream = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
    if (!upstream.ok) {
      return res.status(502).json({ successful: false, message: 'Weather upstream failed' });
    }
    const body = await upstream.json();
    const current = body?.current || {};
    const temp = current.temperature_2m;
    if (temp == null || Number.isNaN(Number(temp))) {
      return res.status(502).json({ successful: false, message: 'Weather data incomplete' });
    }

    res.json({
      successful: true,
      data: {
        city,
        latitude,
        longitude,
        temperature_c: Math.round(Number(temp)),
        condition: weatherCodeLabel(current.weather_code),
        weather_code: current.weather_code ?? null,
        as_of: current.time || new Date().toISOString(),
        source: 'open-meteo',
      },
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return res.status(504).json({ successful: false, message: 'Weather request timed out' });
    }
    next(err);
  }
});

/**
 * GET /platform/profile-poll
 * Returns poll copy + tallies. Includes my_vote when Authorization is present.
 */
router.get('/profile-poll', optionalAuth, async (req, res, next) => {
  try {
    const pollId = PROFILE_POLL.id;
    const votes = await prisma.saved_item.findMany({
      where: { entity_type: POLL_ENTITY, entity_id: pollId },
      select: { user_id: true, meta: true },
    });

    const tallies = Object.fromEntries(PROFILE_POLL.options.map((o) => [o, 0]));
    let myVote = null;
    for (const row of votes) {
      const opt = row.meta && typeof row.meta === 'object' ? row.meta.option : null;
      if (typeof opt === 'string' && Object.prototype.hasOwnProperty.call(tallies, opt)) {
        tallies[opt] += 1;
      }
      if (req.user?.user_id && row.user_id === req.user.user_id && typeof opt === 'string') {
        myVote = opt;
      }
    }

    res.json({
      successful: true,
      data: {
        id: pollId,
        question: PROFILE_POLL.question,
        options: PROFILE_POLL.options,
        tallies,
        total_votes: votes.length,
        my_vote: myVote,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /platform/profile-poll/vote
 * Body: { option: string }. Persists via saved_item (one vote per user per poll id).
 */
router.post('/profile-poll/vote', authenticateToken, async (req, res, next) => {
  try {
    const option = typeof req.body?.option === 'string' ? req.body.option.trim() : '';
    if (!PROFILE_POLL.options.includes(option)) {
      return res.status(400).json({ successful: false, message: 'Invalid option' });
    }
    const pollId = PROFILE_POLL.id;
    const key = {
      user_id_entity_type_entity_id: {
        user_id: req.user.user_id,
        entity_type: POLL_ENTITY,
        entity_id: pollId,
      },
    };
    const existing = await prisma.saved_item.findUnique({ where: key });
    if (existing) {
      await prisma.saved_item.update({
        where: key,
        data: { meta: { option } },
      });
    } else {
      await prisma.saved_item.create({
        data: {
          user_id: req.user.user_id,
          entity_type: POLL_ENTITY,
          entity_id: pollId,
          meta: { option },
        },
      });
    }
    res.json({ successful: true, data: { option } });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /platform/profile-poll/vote — clear the caller's vote.
 */
router.delete('/profile-poll/vote', authenticateToken, async (req, res, next) => {
  try {
    await prisma.saved_item.deleteMany({
      where: {
        user_id: req.user.user_id,
        entity_type: POLL_ENTITY,
        entity_id: PROFILE_POLL.id,
      },
    });
    res.json({ successful: true });
  } catch (err) {
    next(err);
  }
});

function normalizeSidebarState(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const goals = Array.isArray(src.goals)
    ? src.goals.map(Boolean).slice(0, 8)
    : [false, false, false];
  while (goals.length < 3) goals.push(false);
  return {
    sticky_text: typeof src.sticky_text === 'string' ? src.sticky_text.slice(0, 4000) : '',
    goals: goals.slice(0, 3),
    challenge_done_date: typeof src.challenge_done_date === 'string'
      ? src.challenge_done_date.slice(0, 40)
      : null,
  };
}

/**
 * GET /platform/me/sidebar-state — sticky notes, daily goals, challenge completion (auth).
 */
router.get('/me/sidebar-state', authenticateToken, async (req, res, next) => {
  try {
    const row = await prisma.saved_item.findUnique({
      where: {
        user_id_entity_type_entity_id: {
          user_id: req.user.user_id,
          entity_type: SIDEBAR_ENTITY,
          entity_id: SIDEBAR_ID,
        },
      },
    });
    res.json({
      successful: true,
      data: normalizeSidebarState(row?.meta),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /platform/me/sidebar-state — replace sticky / goals / challenge fields (auth).
 */
router.put('/me/sidebar-state', authenticateToken, async (req, res, next) => {
  try {
    const nextState = normalizeSidebarState(req.body);
    const key = {
      user_id_entity_type_entity_id: {
        user_id: req.user.user_id,
        entity_type: SIDEBAR_ENTITY,
        entity_id: SIDEBAR_ID,
      },
    };
    const existing = await prisma.saved_item.findUnique({ where: key });
    if (existing) {
      await prisma.saved_item.update({ where: key, data: { meta: nextState } });
    } else {
      await prisma.saved_item.create({
        data: {
          user_id: req.user.user_id,
          entity_type: SIDEBAR_ENTITY,
          entity_id: SIDEBAR_ID,
          meta: nextState,
        },
      });
    }
    res.json({ successful: true, data: nextState });
  } catch (err) {
    next(err);
  }
});

export default router;
