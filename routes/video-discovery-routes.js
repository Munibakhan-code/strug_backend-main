// routes/video-discovery-routes.js
//
// Signals behind the personalised Videos chip row.
//
// WHY A SEPARATE ROUTER, AND NOT /video/feed:
// /video/feed carries no auth middleware, sets `Cache-Control: public, max-age=60`, and its Redis
// key contains no user id. Personalising it in place would serve one viewer's row to everyone —
// through Redis and through any shared HTTP cache. Everything here is therefore per-user: it runs
// under optionalAuth, caches privately, and keys on user_id.
//
// WHAT IT RETURNS, AND WHAT IT DOESN'T:
// It returns signals — the viewer's own category affinity plus what is popular in their country
// and globally. It deliberately does NOT return a finished chip order. The ordering policy
// (pinned "All", diversity caps, discovery share, stability) already lives in the client, is
// covered by tests there, and applies equally to the logged-out case where this endpoint has
// nothing to say. Keeping one implementation avoids two rankers drifting apart.
//
// SCOPE: mostly reads. The only write is the search log below (plus a fire-and-forget
// interest-profile refresh so home-feed picks up search tokens without waiting on cron).
// Touches no other module's tables and alters no existing endpoint. `user.country` is read, never modified.

import express from 'express';
import prisma from '../utils/prisma-client.js';
import redis from '../utils/redis-client.js';
import { optionalAuth, authenticateToken } from '../middleware/authentication.js';
import { clientIp, detectLocaleFromIp } from '../utils/locale-geo.js';
import { visibleVideoWhere } from '../utils/video-visibility.js';

const router = express.Router();

/** Watch rows scanned per viewer. Enough to characterise taste without an unbounded read. */
const HISTORY_SCAN_LIMIT = 300;
/** Rows scanned when working out what a country watches. */
const REGIONAL_SCAN_LIMIT = 2000;
/** Categories returned per list. */
const LIST_SIZE = 8;
/** Recency half-life, in days — mirrors the client's own decay so the two agree. */
const HALF_LIFE_DAYS = 14;

const CACHE_TTL_PERSONAL = 900;   // 15 min — cheap to recompute, and taste moves slowly
const CACHE_TTL_TRENDS = 1800;    // 30 min — shared across every viewer in a country

const DAY_MS = 86400000;

// The app's canonical visibility predicate, not a local copy: it also excludes deactivated
// channels and banned owners. An earlier hand-rolled version here checked only status +
// processing_status, so a deactivated creator's videos still shaped what everyone was recommended.
const VISIBLE_VIDEO = visibleVideoWhere();

// Scalar-only variant for groupBy. Every other groupBy in this codebase filters on scalars alone,
// so a nested relation filter there would be the first of its kind — and this endpoint cannot be
// exercised locally to prove it works. The difference is negligible for a global popularity list
// (a deactivated channel's old views nudging one category), and not worth an untestable risk.
// The per-user and per-country queries below are findMany, where relation filters are already
// used throughout this repo, and they keep the full gate.
const VISIBLE_VIDEO_SCALAR = { status: 'safe', processing_status: 'done' };

function recencyWeight(watchedAt, now) {
	if (!watchedAt) return 1;
	const ts = new Date(watchedAt).getTime();
	if (!Number.isFinite(ts)) return 1;
	const days = Math.max(0, (now - ts) / DAY_MS);
	return Math.pow(0.5, days / HALF_LIFE_DAYS);
}

/** Sort a { category: score } map into a descending list of category names. */
function topCategories(scores, limit = LIST_SIZE) {
	return Object.entries(scores)
		.filter(([category]) => category)
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))  // stable: ties fall to name order
		.slice(0, limit)
		.map(([category, score]) => ({ category, score: Math.round(score * 100) / 100 }));
}

/**
 * The viewer's own category affinity, from their watch history.
 * Watch history is the one signal that already carries a category, so it is what taste is built
 * from. Likes and subscriptions are deliberately absent: `video_likes` stores only a video id and
 * `subscription` only a channel, so folding them in would cost an extra join per request for a
 * weaker signal. Add them here if that changes.
 */
async function personalCategories(userId, now) {
	const rows = await prisma.watch_history.findMany({
		where: { user_id: userId, video: VISIBLE_VIDEO },
		select: { watched_at: true, video: { select: { category: true } } },
		orderBy: { watched_at: 'desc' },
		take: HISTORY_SCAN_LIMIT,
	});

	const scores = {};
	for (const row of rows) {
		const category = row.video?.category;
		if (!category) continue;
		scores[category] = (scores[category] || 0) + recencyWeight(row.watched_at, now);
	}
	return { categories: topCategories(scores), sampled: rows.length };
}

/**
 * What a country actually watches — derived from the country of the VIEWERS, not of the videos.
 *
 * This is the point of the whole endpoint: no column had to be added to `video` or `channel`, and
 * no backfill was needed. "Arijit Singh is big in Pakistan" falls out of Pakistani viewers'
 * watch history on its own. Shared by every viewer in that country, so it is cached country-wide.
 */
async function regionalCategories(country, now) {
	if (!country) return [];

	const cacheKey = `video:discovery:regional:${country}`;
	const cached = await redis.get(cacheKey);
	if (cached) return JSON.parse(cached);

	const rows = await prisma.watch_history.findMany({
		where: { user: { country }, video: VISIBLE_VIDEO },
		select: { watched_at: true, video: { select: { category: true } } },
		orderBy: { watched_at: 'desc' },
		take: REGIONAL_SCAN_LIMIT,
	});

	const scores = {};
	for (const row of rows) {
		const category = row.video?.category;
		if (!category) continue;
		scores[category] = (scores[category] || 0) + recencyWeight(row.watched_at, now);
	}

	const list = topCategories(scores).map((c) => c.category);
	await redis.set(cacheKey, JSON.stringify(list), 'EX', CACHE_TTL_TRENDS);
	return list;
}

/**
 * Globally popular categories, by view count. The floor under everything: a brand new viewer in a
 * country with no history still gets a sensible row rather than an arbitrary one.
 */
async function globalCategories() {
	const cacheKey = 'video:discovery:global';
	const cached = await redis.get(cacheKey);
	if (cached) return JSON.parse(cached);

	const grouped = await prisma.video.groupBy({
		by: ['category'],
		where: VISIBLE_VIDEO_SCALAR,
		_sum: { views_count: true },
		_count: { video_id: true },
	});

	const list = grouped
		.filter((g) => g.category)
		// Views alone would let one viral upload carry a whole category, so weight by how much
		// content actually sits behind it.
		.map((g) => ({ category: g.category, score: (g._sum.views_count || 0) * Math.log2((g._count.video_id || 0) + 1) }))
		.sort((a, b) => b.score - a.score || a.category.localeCompare(b.category))
		.slice(0, LIST_SIZE)
		.map((g) => g.category);

	await redis.set(cacheKey, JSON.stringify(list), 'EX', CACHE_TTL_TRENDS);
	return list;
}

/**
 * GET /video-discovery/chip-signals
 *
 * Response:
 *   { successful, data: { country, personalised, personal: [{category, score}],
 *                         regional: [category], global: [category] } }
 *
 * Signed out, or signed in with no history: `personal` is empty and `personalised` is false —
 * which is exactly the client's new-user path. Deleting watch history produces the same shape,
 * so a cleared history stops influencing the row on the very next request.
 */
router.get('/chip-signals', optionalAuth, async (req, res, next) => {
	try {
		const userId = req.user?.user_id || null;
		const now = Date.now();

		// The viewer's own profile choice wins — it is explicit, and it survives VPNs and travel.
		// Falling back to the IP lookup means a signed-out visitor, or a signed-in one who never
		// filled the field in, still gets a regional row rather than a purely global one.
		// `countryName` is used, not `country`: the ISO code is "PK", while user.country stores the
		// full name, and the two have to agree for the regional query below to match anything.
		let country = null;
		if (userId) {
			const user = await prisma.user.findUnique({
				where: { user_id: userId },
				select: { country: true },
			});
			country = user?.country || null;
		}
		if (!country) {
			try { country = detectLocaleFromIp(clientIp(req)).countryName || null; } catch { /* geo lookup unavailable */ }
		}

		// Resolved BEFORE the cache is read, and the country is part of the key. Signed-out viewers
		// all share the "anon" identity but no longer share a row: without the country in the key,
		// the first anonymous request would pin one country's row for every anonymous viewer after
		// it — the same class of bug that makes personalising the public /video/feed unsafe.
		const cacheKey = userId
			? `video:discovery:chips:u:${userId}`
			: `video:discovery:chips:anon:${country || 'none'}`;
		const cached = await redis.get(cacheKey);
		if (cached) {
			res.setHeader('Cache-Control', 'private, max-age=60');
			return res.json({ successful: true, data: JSON.parse(cached) });
		}

		const [personal, regional, global] = await Promise.all([
			userId ? personalCategories(userId, now) : Promise.resolve({ categories: [], sampled: 0 }),
			regionalCategories(country, now),
			globalCategories(),
		]);

		const payload = {
			country,
			personalised: personal.categories.length > 0,
			personal: personal.categories,
			regional,
			global,
		};

		await redis.set(cacheKey, JSON.stringify(payload), 'EX', CACHE_TTL_PERSONAL);
		res.setHeader('Cache-Control', 'private, max-age=60');
		return res.json({ successful: true, data: payload });
	} catch (err) {
		next(err);
	}
});

/**
 * POST /video-discovery/search-log
 *
 * Records that a signed-in viewer searched for something. Two uses:
 *   1. a recency / intent signal for personalisation (home-feed interest profile);
 *   2. demand for content that does not exist yet — a query with no results is invisible in watch
 *      history, because there was nothing to watch.
 *
 * Stored verbatim and never rendered back as a chip — the client resolves searches to known
 * categories and drops everything else, so a private phrase cannot surface in the UI.
 */
router.post('/search-log', authenticateToken, async (req, res, next) => {
	try {
		const raw = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
		if (!raw || raw.length > 255) {
			return res.status(400).json({ successful: false, message: 'query required (1-255 chars)' });
		}
		const resultCount = Number.isInteger(req.body?.result_count) ? req.body.result_count : null;

		await prisma.video_search_history.create({
			data: { user_id: req.user.user_id, query: raw, result_count: resultCount },
		});

		// Same fire-and-forget pattern as video likes: getForYou prefers the stored interest
		// profile, so without a refresh new searches would wait up to the cron window.
		const profile = await prisma.social_profile.findUnique({
			where: { user_id: req.user.user_id },
			select: { profile_id: true },
		}).catch((err) => {
			console.error('[video-discovery] social_profile lookup after search-log failed', err?.message || err);
			return null;
		});
		if (profile?.profile_id) {
			const { refreshInterestProfile } = await import('../utils/recommendation-engine.js');
			refreshInterestProfile(profile.profile_id, req.user.user_id).catch((err) => {
				console.error('[video-discovery] refreshInterestProfile after search-log failed', err?.message || err);
			});
		}

		return res.status(201).json({ successful: true });
	} catch (err) {
		next(err);
	}
});

export default router;
