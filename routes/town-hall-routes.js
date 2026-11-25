import express from 'express';
import multer from 'multer';
import { Prisma } from '@prisma/client';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { uploadPublicBlob, isTrustedBlobUrl } from '../utils/azure-storage.js';
import { blobNameFromUrl } from '../workers/video-reconciliation.js';
import { selectBestAd, getOrCreateShadowPost } from '../utils/ads-delivery-engine.js';
import {
    socialRateLimiter,
    engagementRateLimiter,
    uploadRateLimiter,
} from '../middleware/social-rate-limiter.js';
import { profanityFilter } from '../middleware/profanity-filter.js';
import { validateMime, ALLOWED_IMAGE_TYPES, ALLOWED_VIDEO_TYPES, ALLOWED_MEDIA_TYPES } from '../utils/validate-mime.js';
import { optimizeImage } from '../utils/media-processor.js';
import { pushToVideoQueue, enqueueTownhallImport } from '../utils/azure-queue.js';
import { normalizeTwitterSourceUrl } from '../utils/twitter-source.js';
import { generateVideoReadSAS } from '../utils/azure-storage.js';
import redis from '../utils/redis-client.js';
import { sendError, sendSuccess } from '../utils/api-i18n.js';
import { getExcludedTownHallAuthorUserIds, getHiddenProfileIds, notInIds } from '../utils/social-visibility.js';
// 14.0: Personalized ranking + author-diversification for the home feed.
// Adjust this relative path if townhall-recommender.js lives somewhere
// other than /services in your project layout.
import { notify } from '../services/notify.js';
import { assertNoPlatformBlockBetweenUsers, blockedGraphForUser } from '../utils/platform-blocks.js';
import {
    getUserPersonalizationContext,
    scoreCandidate,
    diversifyByAuthor,
    makeSeededRandom,
    utcDayBucket,
} from '../services/townhall-recommender.js';

// ... (Other imports and config remain the same) ...

// =====================================================================
// PRODUCTION-GRADE REDIS CACHE-ASIDE FAIL-OPEN HELPERS
// =====================================================================

// Safely get a value from Redis cache (Fail-Open)
async function safeCacheGet(key) {
    try {
        if (redis && redis.status === 'ready') {
            return await redis.get(key);
        }
    } catch (err) {
        console.warn(`⚠️ [Redis Proxy Fail-Open] GET failed for key: ${key}. Error:`, err.message);
    }
    return null;
}

// Safely set a value in Redis cache with custom TTL (Fail-Open)
async function safeCacheSet(key, value, ttlSeconds) {
    try {
        if (redis && redis.status === 'ready') {
            if (ttlSeconds) {
                await redis.set(key, value, 'EX', ttlSeconds);
            } else {
                await redis.set(key, value);
            }
        }
    } catch (err) {
        console.warn(`⚠️ [Redis Proxy Fail-Open] SET failed for key: ${key}. Error:`, err.message);
    }
}

// Safely delete cache keys by wildcard pattern (Fail-Open). Uses SCAN, not KEYS.
async function safeCacheDelPattern(pattern) {
    try {
        if (redis && redis.status === 'ready') {
            let cursor = '0';
            let cleared = 0;
            do {
                const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
                cursor = next;
                if (keys?.length) {
                    await redis.del(...keys);
                    cleared += keys.length;
                }
            } while (cursor !== '0');
            if (cleared > 0) {
                console.log(`🧹 [Redis Invalidation] Cleared ${cleared} keys matching: ${pattern}`);
            }
        }
    } catch (err) {
        console.warn(`⚠️ [Redis Proxy Fail-Open] DEL pattern failed for: ${pattern}. Error:`, err.message);
    }
}

// Global Invalidation Hook for Town Hall actions
async function invalidateTownHallCache() {
    // 7.3: Automatically invalidate all Town Hall cache namespaces to preserve DB-Redis consistency
    await safeCacheDelPattern('townhall:*');
}

// Viewer-scoped invalidation. A like/unlike bakes THIS viewer's `liked`/`is_liked_by_me`
// state (and the like count) into their cached feed pages + spotlight. Likes happen far
// more often than posts, so nuking every user's Town Hall cache (invalidateTownHallCache)
// on every like would gut the cache. Clear only the actor's own per-user feed + spotlight
// so their like reflects immediately on reload; other viewers pick up the new count on the
// live `townhall-post-updated` socket event and at their own cache TTL.
async function invalidateViewerTownHallCache(userId) {
    await safeCacheDelPattern(`townhall:feed:v2:user:${userId}:*`);
    await safeCacheDelPattern(`townhall:feed:ranked:v1:user:${userId}:*`);
    await safeCacheDelPattern(`townhall:spotlight:user:${userId}`);
}


const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const router = express.Router();

// Escape user-controlled text before it is interpolated into the /share/:id HTML shell.
// Without this, post content / author names / query params break out of attributes and the
// <script> block (stored + reflected XSS). Covers the 5 HTML-significant characters.
function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Author identity selected for every Town Hall post (reused for the quoted post too).
// Uses social_profiles so the feed shows display_name/handle (not the raw Google name).
// profile_id is needed for follow counts.
const AUTHOR_SELECT = {
    user_id: true,
    name: true,
    username: true,
    // `social_profiles` is a to-ONE relation (social_profile.user_id is @unique), so it
    // must NOT carry `take` — Prisma 6.19+ rejects `take` on a to-one include with
    // "Unknown argument `take`", which 500'd every Town Hall read using this select.
    // Prisma returns a single object (or null); normalizeAuthor() re-wraps it into the
    // 1-element array the frontend expects (it reads `user.social_profiles?.[0]`).
    social_profiles: {
        select: { profile_id: true, display_name: true, handle: true, profile_pic_url: true, is_verified: true, verification_type: true },
    },
};

const POST_INCLUDE = {
    user: { select: AUTHOR_SELECT },
    quote_post: {
        include: {
            user: { select: AUTHOR_SELECT },
            _count: { select: { likes: true, replies: true, reposts: true, views: true, saves: true } },
        },
    },
    product: {
        include: {
            product_variation: true
        }
    },
    // Production Upgrade: Automatically count poll votes natively inside PostgreSQL using Prisma Grouping
    poll_options: {
        include: {
            _count: { select: { votes: true } }
        }
    },
    _count: { select: { likes: true, replies: true, reposts: true, views: true, saves: true } },
};

// A post is publicly visible when it has no schedule, or its scheduled time has passed.
const visibleNowWhere = () => ({
    OR: [{ scheduled_at: null }, { scheduled_at: { lte: new Date() } }],
});

// A post banned by a moderator must not reach OTHER users. `is_banned` was previously
// written by the board moderation tools but read almost nowhere, so banning a post
// changed essentially nothing about who saw it — it stayed in the home feed, following
// feed, trending, profiles, replies and quotes. Every read path that returns posts to a
// viewer now composes this.
//
// NOTE: this deliberately does NOT filter `is_sensitive`. Sensitive is a "show behind a
// warning" signal, not a removal — filtering it out of feeds would silently delete
// content a moderator only meant to flag. Spotlight is the one exception: it PROMOTES a
// post, and promoting flagged content is different from merely displaying it.
const notBannedWhere = () => ({ is_banned: false });

/** Exclude blocked/muted/private-not-followed authors from organic SELECT branch. */
function organicAuthorExcludeSql(excludedUserIds) {
    if (!excludedUserIds?.length) return Prisma.empty;
    return Prisma.sql`AND p."user_id" NOT IN (${Prisma.join(excludedUserIds)})`;
}

/** Exclude hidden authors + hidden reposters from repost SELECT branch. */
function repostAuthorExcludeSql(excludedUserIds) {
    if (!excludedUserIds?.length) return Prisma.empty;
    return Prisma.sql`
      AND p."user_id" NOT IN (${Prisma.join(excludedUserIds)})
      AND r."user_id" NOT IN (${Prisma.join(excludedUserIds)})
    `;
}

const TOWNHALL_MEDIA_CONTAINER = process.env.AZURE_TOWNHALL_POSTS_CONTAINER || 'townhall-posts';

/** Board-applied posting ban — must be checked on create + upload, not only stored as a tag. */
async function isTownHallRestricted(userId) {
    if (!userId) return false;
    const tag = await prisma.user_tag.findUnique({
        where: { user_id_tag: { user_id: userId, tag: 'RESTRICTED_TOWNHALL' } },
        select: { tag_id: true },
    });
    return !!tag;
}

/**
 * media_url on create must point at our Town Hall blob container (same place /upload writes).
 * Blocks arbitrary phishing / malware URLs and garbage fed into the video worker.
 */
function isAllowedTownHallMediaUrl(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return false;
    const trimmed = urlStr.trim();
    if (!trimmed) return false;
    if (isTrustedBlobUrl(trimmed, TOWNHALL_MEDIA_CONTAINER)) return true;
    try {
        const u = new URL(trimmed);
        const host = u.hostname.toLowerCase();
        // Azurite / local emulator paths: .../devstoreaccount1/townhall-posts/<blob>
        if (host === '127.0.0.1' || host === 'localhost') {
            const parts = u.pathname.replace(/^\/+/, '').split('/');
            const containerIdx = parts[0] === 'devstoreaccount1' ? 1 : 0;
            return parts[containerIdx] === TOWNHALL_MEDIA_CONTAINER && parts.length > containerIdx + 1;
        }
    } catch {
        return false;
    }
    return false;
}

/** Banned or not-yet-published posts must not accept likes/reposts/views/saves/votes. */
function assertPostEngageable(post, { allowAuthorScheduled = false, viewerId = null } = {}) {
    if (!post) return { ok: false, status: 404, message: 'Post not found' };
    if (post.is_banned) return { ok: false, status: 404, message: 'Post not found' };
    if (post.scheduled_at && post.scheduled_at > new Date()) {
        if (allowAuthorScheduled && viewerId != null && post.user_id === viewerId) {
            return { ok: true };
        }
        return { ok: false, status: 404, message: 'Post not found' };
    }
    return { ok: true };
}

/** Same visibility as GET /:id: author can see own banned/scheduled posts; others cannot. */
function assertPostVisibleToViewer(post, { viewerId = null } = {}) {
    if (!post) return { ok: false, status: 404, message: 'Post not found' };
    if (post.is_banned && post.user_id !== viewerId) {
        return { ok: false, status: 404, message: 'Post not found' };
    }
    if (post.scheduled_at && post.scheduled_at > new Date() && post.user_id !== viewerId) {
        return { ok: false, status: 404, message: 'Post not found' };
    }
    return { ok: true };
}

/**
 * #1200 — permalink + replies/quotes must share one parent gate.
 * 404 when the viewer cannot see the post (banned/scheduled/blocked/private).
 */
async function assertParentVisibleToViewer(parent, {
    viewerId = null,
    viewerProfileId = null,
    blockedUserIds = [],
} = {}) {
    const gate = assertPostVisibleToViewer(parent, { viewerId });
    if (!gate.ok) return gate;

    const authorId = Number(parent.user_id);
    if (viewerId != null && authorId === Number(viewerId)) return { ok: true };

    if (blockedUserIds.some((id) => Number(id) === authorId)) {
        return { ok: false, status: 404, message: 'Post not found' };
    }

    const authorProfile = await prisma.social_profile.findUnique({
        where: { user_id: authorId },
        select: { profile_id: true, is_private: true },
    });
    if (authorProfile?.is_private) {
        if (!viewerProfileId) {
            return { ok: false, status: 404, message: 'Post not found' };
        }
        const follows = await prisma.follower.findFirst({
            where: { follower_id: viewerProfileId, following_id: authorProfile.profile_id, status: 'accepted' },
            select: { id: true },
        });
        if (!follows) {
            return { ok: false, status: 404, message: 'Post not found' };
        }
    }
    return { ok: true };
}

async function loadVisibleParentOrGate(req, postId) {
    if (!Number.isInteger(postId) || postId <= 0) {
        return { ok: false, status: 400, message: 'Invalid id' };
    }
    const viewerId = req.user?.user_id ?? null;
    const blockedGraph = await blockedGraphForUser(viewerId);
    const parent = await prisma.town_hall_post.findUnique({
        where: { post_id: postId },
        select: { post_id: true, user_id: true, is_banned: true, scheduled_at: true },
    });
    const gate = await assertParentVisibleToViewer(parent, {
        viewerId,
        viewerProfileId: req.user?.profile_id ?? null,
        blockedUserIds: blockedGraph.userIds,
    });
    if (!gate.ok) return gate;
    return { ok: true, parent, blockedGraph };
}

/** Collect every descendant reply id (BFS) so delete can remove the whole thread. */
async function collectDescendantReplyIds(rootPostId) {
    const all = [];
    let frontier = [rootPostId];
    while (frontier.length > 0) {
        const children = await prisma.town_hall_post.findMany({
            where: { parent_id: { in: frontier } },
            select: { post_id: true },
        });
        const childIds = children.map((c) => c.post_id);
        if (childIds.length === 0) break;
        all.push(...childIds);
        frontier = childIds;
    }
    return all;
}

/** Public / crawler-safe post shape (no viewer-specific like/save rows). */
function toPublicPost(post) {
    if (!post) return null;
    const shaped = withViewerState({
        ...post,
        likes: [],
        reposts: [],
        saves: [],
    });
    // Strip toggle fields that imply a viewer session.
    delete shaped.liked;
    delete shaped.reposted;
    delete shaped.saved;
    delete shaped.is_liked_by_me;
    delete shaped.likes;
    delete shaped.reposts;
    delete shaped.saves;
    return shaped;
}

// Minimum deliberate interactions (likes + replies + reposts) before a post is eligible
// to be FEATURED as Post of the Week. Views deliberately don't count — see /spotlight.
const MIN_SPOTLIGHT_INTERACTIONS = 3;

// POST_INCLUDE + the viewer's own like/repost rows so the client can render
// liked/reposted toggle state correctly (and offer "Undo repost").
const viewerInclude = (viewerId) => ({
    ...POST_INCLUDE,
    likes: { where: { user_id: viewerId }, select: { like_id: true } },
    reposts: { where: { user_id: viewerId }, select: { repost_id: true } },
    // Only the viewer's own save row, so we never ship every saver of a post.
    saves: { where: { user_id: viewerId }, select: { save_id: true } },
    poll_options: {
        include: {
            _count: { select: { votes: true } },
            votes: { where: { user_id: viewerId }, select: { vote_id: true } },
        },
    },
});

// social_profiles is a to-one relation → Prisma returns an object (or null), but the
// frontend reads `user.social_profiles?.[0]`. Re-wrap into a 1-element array (or []) so
// the API shape the client expects is preserved.
const normalizeAuthor = (u) => {
    if (!u) return u;
    const sp = u.social_profiles;
    return { ...u, social_profiles: sp ? (Array.isArray(sp) ? sp : [sp]) : [] };
};

// === REPLACE withViewerState IN routes/town-hall-routes.js ===
const withViewerState = (p) => {
    if (!p) return p;
    return {
        ...p,
        user: normalizeAuthor(p.user),
        quote_post: p.quote_post ? { ...p.quote_post, user: normalizeAuthor(p.quote_post.user) } : null,
        liked: (p.likes?.length ?? 0) > 0,
        reposted: (p.reposts?.length ?? 0) > 0,
        saved: (p.saves?.length ?? 0) > 0,
        is_liked_by_me: (p.likes?.length ?? 0) > 0,
        
        pinned_product: p.product ? {
            listing_id: p.product.listing_id,
            name: p.product.name,
            description: p.product.description,
            price: p.product.product_variation?.[0]?.price || 0.00,
            discount_pct: p.product.product_variation?.[0]?.discount_pct || 0,
            image_url: p.product.image_url || p.product.product_variation?.[0]?.image_url || null,
            availability: p.product.availability || p.product.product_variation?.[0]?.stock || 0,
            variations: p.product.product_variation || []
        } : null,

        // Production Upgrade: Format poll options and dynamic total vote counts cleanly for the frontend
        poll: p.poll_options && p.poll_options.length > 0 ? {
            options: p.poll_options.map(o => ({
                option_id: o.option_id,
                text: o.option_text,
                votes_count: o._count?.votes || 0
            })),
            total_votes: p.poll_options.reduce((sum, o) => sum + (o._count?.votes || 0), 0),
            voted_option_id: p.poll_options.find(o => (o.votes?.length ?? 0) > 0)?.option_id ?? null,
        } : null
    };
};

// GET /town-hall — paginated feed (top-level posts + reposts merged by recency).
// GET /town-hall — Paginated Feed (Optimized via PostgreSQL UNION on Database Level)
// GET /town-hall — Paginated Feed (Optimized via PostgreSQL UNION with Pinned Post Support on Database Level)
// GET /town-hall — Paginated Feed (Optimized with Redis Cache-Aside & PostgreSQL UNION)
// 14.4: How many posts+reposts (pinned excluded) we personalize/diversify
// across per user per day. Deep infinite-scroll beyond this many items
// falls back to plain recency — bounds the extra scoring/hydration work
// this endpoint now does instead of a straight LIMIT/OFFSET.
const FEED_PERSONALIZATION_CEILING = 600;

// 15.0: How long one seeded ranking (see rankedListKey below) stays the
// source of truth for every page a user requests. Kept short enough that
// new posts surface promptly (X.com-style feed freshness), long enough
// that a normal scroll session never straddles a re-rank.
const RANKED_FEED_TTL_SECONDS = 10 * 60; // 10 minutes

router.get('/', authenticateToken, async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(50, parseInt(req.query.limit, 10) || 20);
        const userId = req.user.user_id;
        const blockedGraph = await blockedGraphForUser(userId);
        const skip = (page - 1) * limit;
        const dayBucket = utcDayBucket();

        // 14.5: Cache key now covers EVERY page (not just page 1) and rotates
        // with the UTC day bucket the ranking below is seeded on, so a cache
        // hit always matches what a fresh computation would have produced.
        const cacheKey = `townhall:feed:v2:user:${userId}:${dayBucket}:page_${page}:limit_${limit}`;

        // 7.1 & 7.2: Check Redis Cache-Aside first (Fail-Open protected)
        const cachedData = await safeCacheGet(cacheKey);
        if (cachedData) {
            console.log(`🚀 [Redis Cache-Aside] Cache HIT for ${cacheKey}`);
            const cached = JSON.parse(cachedData);
            return res.json(Array.isArray(cached) ? cached.filter((post) => !blockedGraph.userIds.includes(Number(post.user_id))) : cached);
        }

        const limitInt = Number.isInteger(limit) ? limit : 20;
        const skipInt = Number.isInteger(skip) ? skip : 0;
        const withinPersonalizationWindow = (skipInt + limitInt) <= FEED_PERSONALIZATION_CEILING;
        const excludedAuthorIds = await getExcludedTownHallAuthorUserIds(req.user?.profile_id);
        const organicExclude = organicAuthorExcludeSql(excludedAuthorIds);
        const repostExclude = repostAuthorExcludeSql(excludedAuthorIds);

        let rawItems;

        if (withinPersonalizationWindow) {
            // 15.0 FIX — "infinity scroll catches up" / duplicate-posts bug.
            // The window used to be re-sized to `skip+limit` on every request,
            // so page 6 scored a bigger candidate set than page 1. Because
            // scoring walks one seeded RNG in a single pass over the whole
            // window (sorted by post_id), a bigger window inserted extra
            // (older, lower post_id) posts *ahead* of ones already scored on
            // an earlier page — shifting every subsequent RNG draw and
            // silently re-ordering/duplicating posts a few pages in.
            //
            // Fix: always rank against the FULL ceiling window, compute it
            // once per user/day, and cache the entire ranked list. Every page
            // then does a plain array slice out of one stable list — same
            // order every time, no matter what page asks for it first. This
            // also removes almost all of the per-page cost (scoring +
            // diversifying ~600 posts) for every page after the first.
            const rankedListKey = `townhall:feed:ranked:v1:user:${userId}:${dayBucket}`;
            let rankedList = null;
            const cachedRanked = await safeCacheGet(rankedListKey);
            if (cachedRanked) {
                try { rankedList = JSON.parse(cachedRanked); } catch { rankedList = null; }
            }

            if (!rankedList) {
                const candidateWindow = await prisma.$queryRaw`
                    SELECT 
                        p."post_id", 
                        p."created_at" AS "sorting_date", 
                        p."is_pinned",
                        NULL::integer AS "repost_user_id", 
                        NULL::varchar AS "repost_user_name"
                    FROM "town_hall_post" p
                    WHERE p."parent_id" IS NULL 
                      AND (p."scheduled_at" IS NULL OR p."scheduled_at" <= NOW())
                      AND p."is_banned" = false
                      ${organicExclude}
                    
                    UNION ALL
                    
                    SELECT 
                        r."post_id", 
                        r."created_at" AS "sorting_date", 
                        p."is_pinned",
                        r."user_id" AS "repost_user_id", 
                        u."name" AS "repost_user_name"
                    FROM "town_hall_repost" r
                    JOIN "user" u ON r."user_id" = u."user_id"
                    JOIN "town_hall_post" p ON r."post_id" = p."post_id"
                    WHERE p."parent_id" IS NULL
                      AND p."is_banned" = false
                      AND (p."scheduled_at" IS NULL OR p."scheduled_at" <= NOW())
                      ${repostExclude}
                    
                    ORDER BY "is_pinned" DESC, "sorting_date" DESC
                    LIMIT ${FEED_PERSONALIZATION_CEILING}
                `;

                const pinnedItems = candidateWindow.filter(r => r.is_pinned);
                const regularItems = candidateWindow.filter(r => !r.is_pinned);

                let orderedRegular = [];
                if (regularItems.length > 0) {
                    const uniquePostIds = [...new Set(regularItems.map(r => r.post_id))];

                    // Lightweight fields for SCORING ONLY — the heavier viewerInclude()
                    // hydration (likes/quote_post/product/poll etc.) still only ever
                    // runs on the final page slice, further down, exactly as before.
                    const scoringPosts = await prisma.town_hall_post.findMany({
                        where: { post_id: { in: uniquePostIds } },
                        select: {
                            post_id: true,
                            user_id: true,
                            content: true,
                            created_at: true,
                            user: { select: { social_profiles: { select: { profile_id: true } } } },
                            _count: { select: { likes: true, replies: true, reposts: true } },
                        },
                    });
                    const scoringMap = new Map(scoringPosts.map(p => [p.post_id, p]));

                    const context = await getUserPersonalizationContext(userId);
                    // scoreCandidate derives its per-post jitter from this seed STRING (via
                    // jitterForPost). Passing the makeSeededRandom function here instead would
                    // stringify to identical source for every user → jitter no longer per-user.
                    const seedString = `${userId}:${dayBucket}`;

                    // Score in post_id order (not DB return order) so the seeded jitter
                    // is consumed identically on every rebuild for this user/day.
                    const sortedRegular = [...regularItems].sort((a, b) => a.post_id - b.post_id);

                    const scoredItems = sortedRegular.map(raw => {
                        const post = scoringMap.get(raw.post_id);
                        const candidate = {
                            post_id: raw.post_id,
                            content: post?.content ?? '',
                            created_at: post?.created_at ?? raw.sorting_date,
                            likes: post?._count?.likes ?? 0,
                            replies: post?._count?.replies ?? 0,
                            reposts: post?._count?.reposts ?? 0,
                            authorProfileId: post?.user?.social_profiles?.profile_id ?? null,
                        };
                        // Diversity key: a repost is attributed to the *reposting*
                        // user for clustering purposes — that's who visually owns
                        // that slot in the feed ("X reposted"). Organic posts are
                        // attributed to their author. This is what stops one
                        // user's burst of posts (or reposts) from ever stacking.
                        const authorKey = raw.repost_user_id ?? post?.user_id ?? `post:${raw.post_id}`;
                        return {
                            raw,
                            score: scoreCandidate(candidate, context, seedString),
                            authorKey,
                        };
                    });

                    orderedRegular = diversifyByAuthor(scoredItems, { limit: FEED_PERSONALIZATION_CEILING }).map(d => d.raw);
                }

                rankedList = [...pinnedItems, ...orderedRegular];

                // Cache the whole ranked list so every subsequent page this
                // user requests (within the TTL) slices the same array.
                await safeCacheSet(rankedListKey, JSON.stringify(rankedList), RANKED_FEED_TTL_SECONDS);
            }

            rawItems = rankedList.slice(skipInt, skipInt + limitInt);
        } else {
            // Deep scroll past personalization: continue with recency, but exclude
            // every post_id already in the ranked window so the ordering seam
            // cannot resurface duplicates from the first ~600 items.
            const rankedListKey = `townhall:feed:ranked:v1:user:${userId}:${dayBucket}`;
            let rankedPostIds = [];
            const cachedRanked = await safeCacheGet(rankedListKey);
            if (cachedRanked) {
                try {
                    rankedPostIds = JSON.parse(cachedRanked).map((r) => r.post_id).filter(Boolean);
                } catch { rankedPostIds = []; }
            }
            // The reduced offset is only safe when we actually have the ranked ids to exclude.
            // On a cache miss — Redis down, TTL expired, or a cold key — rankedPostIds is empty,
            // so there is nothing to subtract and OFFSET (skip - 600) would re-serve the first
            // 600 posts the viewer already scrolled past. Redis is not always provisioned here,
            // so that is a live path, not an edge case. Fall back to the plain offset instead.
            const haveRankedIds = rankedPostIds.length > 0;
            const deepOffset = haveRankedIds
                ? Math.max(0, skipInt - FEED_PERSONALIZATION_CEILING)
                : skipInt;
            const rankedExclude = haveRankedIds
                ? Prisma.sql`AND p."post_id" NOT IN (${Prisma.join(rankedPostIds)})`
                : Prisma.empty;

            rawItems = await prisma.$queryRaw`
                SELECT 
                    p."post_id", 
                    p."created_at" AS "sorting_date", 
                    p."is_pinned",
                    NULL::integer AS "repost_user_id", 
                    NULL::varchar AS "repost_user_name"
                FROM "town_hall_post" p
                WHERE p."parent_id" IS NULL 
                  AND (p."scheduled_at" IS NULL OR p."scheduled_at" <= NOW())
                  AND p."is_banned" = false
                  ${organicExclude}
                  ${rankedExclude}
                
                UNION ALL
                
                SELECT 
                    r."post_id", 
                    r."created_at" AS "sorting_date", 
                    p."is_pinned",
                    r."user_id" AS "repost_user_id", 
                    u."name" AS "repost_user_name"
                FROM "town_hall_repost" r
                JOIN "user" u ON r."user_id" = u."user_id"
                JOIN "town_hall_post" p ON r."post_id" = p."post_id"
                WHERE p."parent_id" IS NULL
                  AND p."is_banned" = false
                  AND (p."scheduled_at" IS NULL OR p."scheduled_at" <= NOW())
                  ${repostExclude}
                  ${rankedExclude}
                
                ORDER BY "is_pinned" DESC, "sorting_date" DESC
                LIMIT ${limitInt} OFFSET ${deepOffset}
            `;
        }

        const activeAd = await selectBestAd(req.adContext).catch(() => null);
        const postIds = rawItems.map(item => item.post_id);

        if (postIds.length === 0) {
            return res.json([]);
        }

        const hydratedPosts = await prisma.town_hall_post.findMany({
            where: { post_id: { in: postIds } },
            include: viewerInclude(userId),
        });

        const postsMap = new Map(hydratedPosts.map(p => [p.post_id, p]));
        
        let parsedPosts = rawItems
            .map(raw => {
                const post = postsMap.get(raw.post_id);
                if (!post) return null;
                
                const postWithViewer = withViewerState(post);
                if (raw.repost_user_id) {
                    return {
                        ...postWithViewer,
                        _repostBy: raw.repost_user_name || 'Someone',
                        _repostAt: raw.sorting_date,
                        _repostUserId: raw.repost_user_id,
                    };
                }
                return postWithViewer;
            })
            .filter(Boolean)
            .filter((post) => !blockedGraph.userIds.includes(Number(post.user_id)));

        if (activeAd && parsedPosts.length > 5) {
            const shadowPostId = await getOrCreateShadowPost(
                activeAd.campaign_id,
                activeAd.advertiser_id,
                activeAd.headline || activeAd.title,
            );

            if (shadowPostId) {
                const virtualAdId = -1 * (shadowPostId + 100);

                const sponsoredMicroPost = {
                    post_id:       virtualAdId,
                    user_id:       activeAd.advertiser_id,
                    content:       activeAd.description || activeAd.title,
                    parent_id:     null,
                    created_at:    new Date(),
                    updated_at:    new Date(),
                    media_url:     activeAd.media_url,
                    media_type:    activeAd.ad_type === 'VIDEO' ? 'video' : 'image',
                    quote_post_id: null,
                    scheduled_at:  null,
                    view_count:    0,
                    is_ad:         true,
                    campaign_id:   activeAd.campaign_id,
                    liked:         false,
                    reposted:      false,
                    is_liked_by_me: false,
                    cta_text:      activeAd.cta_text || 'LEARN_MORE',
                    target_url:    activeAd.target_url,
                    user: {
                        user_id:  activeAd.advertiser_id,
                        name:     activeAd.headline || activeAd.title,
                        username: 'Sponsored',
                        social_profiles: [{
                            profile_id:      shadowPostId,
                            display_name:    activeAd.headline || activeAd.title,
                            handle:          'Sponsored',
                            profile_pic_url: null,
                            is_verified:     true,
                        }],
                    },
                    quote_post: null,
                    _count: { likes: 0, replies: 0, reposts: 0, views: 0, saves: 0 },
                };

                parsedPosts.splice(5, 0, sponsoredMicroPost);
            }
        }

        // 7.7: Apply 5-minute TTL + random Jitter (0-30s) to prevent Cache Stampede (thundering herd)
        // 14.8: No longer gated to page 1 only — every page/limit combo for
        // this user+day is cacheable now that the cache key is specific to it.
        if (parsedPosts.length > 0) {
            const jitter = Math.floor(Math.random() * 30);
            const ttl = 300 + jitter; // 5 mins + jitter
            await safeCacheSet(cacheKey, JSON.stringify(parsedPosts), ttl);
            console.log(`💾 [Redis Cache-Aside] Saved ${cacheKey} with TTL: ${ttl}s`);
        }

        res.json(parsedPosts);
    } catch (e) {
        console.error('Failed to fetch posts via SQL Union:', e);
        res.status(500).json({ message: 'Failed to fetch posts' });
    }
});

// GET /town-hall/following — feed limited to authors the viewer follows.
// Registered before /:id so the literal path isn't swallowed by the param route.
// GET /town-hall/following — feed limited to authors the viewer follows (Optimized Single Query JOIN)
router.get('/following', authenticateToken, async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(50, parseInt(req.query.limit, 10) || 20);
        const myProfileId = req.user?.profile_id;
        const userId = req.user?.user_id;
        const blockedGraph = await blockedGraphForUser(userId);

        if (!myProfileId) return res.json([]);

        const excludedAuthorIds = await getExcludedTownHallAuthorUserIds(myProfileId);

        // advanced single Prisma JOIN collapsing 3 sequential lookups
        const posts = await prisma.town_hall_post.findMany({
            where: {
                parent_id: null,
                ...(blockedGraph.userIds.length ? { user_id: { notIn: blockedGraph.userIds } } : {}),
                user: {
                    social_profiles: {
                        followers: {
                            some: {
                                follower_id: myProfileId,
                                status: 'accepted',
                            }
                        }
                    }
                },
                ...notBannedWhere(),
                ...visibleNowWhere(),
                ...notInIds('user_id', excludedAuthorIds),
            },
            orderBy: { created_at: 'desc' },
            skip: (page - 1) * limit,
            take: limit,
            include: viewerInclude(userId),
        });

        res.json(posts.map(withViewerState));
    } catch (e) {
        console.error('Failed to fetch following feed:', e);
        res.status(500).json({ message: 'Failed to fetch following feed' });
    }
});





// Shared account-search query used by /search-users and the unified /search.
async function searchTownHallUsers(q, viewerId, take = 20, viewerProfileId = null) {
    const blockedGraph = await blockedGraphForUser(viewerId);
    const hiddenProfileIds = viewerProfileId ? await getHiddenProfileIds(viewerProfileId) : [];
    const matched = await prisma.user.findMany({
        where: {
            account_status: 'active',
            deleted_at: null,
            ...(blockedGraph.userIds.length ? { user_id: { notIn: blockedGraph.userIds } } : {}),
            // A bare `social_profiles: { is: {...} }` on a nullable to-one REQUIRES the related
            // row to exist, so filtering that way dropped every user without a social_profile
            // out of search the moment the viewer blocked or muted anyone. Keep them by
            // matching "no profile at all" as well. Nested in AND so the search-term OR below
            // is not overwritten.
            ...(hiddenProfileIds.length
                ? {
                    AND: [{
                        OR: [
                            { social_profiles: { is: null } },
                            { social_profiles: { is: { profile_id: { notIn: hiddenProfileIds } } } },
                        ],
                    }],
                }
                : {}),
            OR: [
                { username: { contains: q, mode: 'insensitive' } },
                { name: { contains: q, mode: 'insensitive' } },
                {
                    social_profiles: {
                        OR: [
                            { handle: { contains: q, mode: 'insensitive' } },
                            { display_name: { contains: q, mode: 'insensitive' } }
                        ]
                    }
                }
            ]
        },
        take,
        select: {
            user_id: true,
            name: true,
            username: true,
            social_profiles: {
                select: {
                    profile_id: true,
                    handle: true,
                    display_name: true,
                    profile_pic_url: true,
                    is_verified: true
                }
            }
        }
    });
    return matched.map(u => normalizeAuthor(u));
}

// Shared post-search query used by /search-posts and the unified /search.
async function searchTownHallPosts(q, viewerId, take = 20, viewerProfileId = null) {
    const blockedGraph = await blockedGraphForUser(viewerId);
    const excludedAuthorIds = await getExcludedTownHallAuthorUserIds(viewerProfileId);
    const excludedUserIds = Array.from(new Set([
        ...(blockedGraph.userIds || []),
        ...(excludedAuthorIds || []),
    ].map(Number).filter(Boolean)));
    const posts = await prisma.town_hall_post.findMany({
        where: {
            parent_id: null,
            content: { contains: q, mode: 'insensitive' },
            ...visibleNowWhere(),
            ...notBannedWhere(),
            ...notInIds('user_id', excludedUserIds),
        },
        orderBy: { created_at: 'desc' },
        take,
        include: viewerInclude(viewerId),
    });
    return posts.map(withViewerState);
}

router.get('/search-users', authenticateToken, async (req, res) => {
    try {
        const q = String(req.query.q || '').trim();
        if (!q) {
            return res.json({ successful: true, users: [] });
        }
        const users = await searchTownHallUsers(q, req.user?.user_id, 20, req.user?.profile_id);
        res.json({ successful: true, users });
    } catch (e) {
        console.error('USER SEARCH FAILED:', e.message);
        res.status(500).json({ message: 'Internal server error during search' });
    }
});


// GET /town-hall/search-posts?q= — free-text search over top-level post content (#338).
// Accounts are covered by /search-users; this is the "find posts" half of Town Hall search.
// Returns the same hydrated/viewer-state post shape as the feed so the UI can reuse SocialPostCard.
router.get('/search-posts', authenticateToken, async (req, res) => {
    try {
        const q = String(req.query.q || '').trim();
        if (!q) {
            return res.json({ successful: true, posts: [] });
        }
        const posts = await searchTownHallPosts(q, req.user?.user_id, 20, req.user?.profile_id);
        res.json({ successful: true, posts });
    } catch (e) {
        console.error('POST SEARCH FAILED:', e.message);
        res.status(500).json({ message: 'Internal server error during post search' });
    }
});


// GET /town-hall/search?q= — the main, unified Town Hall search: one query,
// both accounts AND post content, in a single round trip. Runs the same
// two queries backing /search-users and /search-posts (kept live for any
// existing caller) in parallel and returns both result sets together.
router.get('/search', authenticateToken, async (req, res) => {
    try {
        const q = String(req.query.q || '').trim();
        if (!q) {
            return res.json({ successful: true, users: [], posts: [] });
        }
        const [users, posts] = await Promise.all([
            searchTownHallUsers(q, req.user?.user_id, 20, req.user?.profile_id),
            searchTownHallPosts(q, req.user?.user_id, 20, req.user?.profile_id),
        ]);
        res.json({ successful: true, users, posts });
    } catch (e) {
        console.error('UNIFIED TOWN HALL SEARCH FAILED:', e.message);
        res.status(500).json({ message: 'Internal server error during search' });
    }
});




// GET /town-hall/saved — Fetch all saved posts for the current user
// GET /town-hall/saved — Fetch saved posts defensively
router.get('/saved', authenticateToken, async (req, res) => {
    try {
        const user_id = req.user.user_id;
        const blockedGraph = await blockedGraphForUser(user_id);
        const excludedAuthorIds = new Set(
            await getExcludedTownHallAuthorUserIds(req.user?.profile_id)
        );

        const savedRecords = await prisma.town_hall_post_save.findMany({
            where: { user_id: user_id },
            include: {
                post: {
                    include: viewerInclude(user_id)
                }
            },
            orderBy: { created_at: 'desc' }
        });

        // Defensively filter deleted / banned / not-yet-published / hidden authors
        const posts = savedRecords
            .filter(record => {
                const p = record.post;
                if (!p) return false;
                if (p.is_banned) return false;
                if (p.scheduled_at && p.scheduled_at > new Date()) return false;
                if (blockedGraph.userIds.includes(Number(p.user_id))) return false;
                if (excludedAuthorIds.has(p.user_id)) return false;
                return true;
            })
            .map(record => ({ ...withViewerState(record.post), saved: true }));
        res.json(posts);
    } catch (e) {
        console.error('Failed to fetch saved posts:', e);
        res.status(500).json({ message: 'Failed to fetch saved posts' });
    }
});


// GET /town-hall/trending — engagement-scored feed (last 7 days, time-decayed).
// MUST be registered before the bare /:id route below, or Express matches "trending" as an :id.
// GET /town-hall/trending — engagement-scored feed with 120s Redis Cache-Aside Wrapper
router.get('/trending', authenticateToken, async (req, res) => {
    try {
        const limit = Math.min(50, parseInt(req.query.limit, 10) || 20);
        const viewerId = req.user?.user_id;
        const blockedGraph = await blockedGraphForUser(viewerId);
        const trendingCacheKey = `townhall:trending:user:${viewerId}`;

        // 7.4: Try fetching from cache-aside wrapper first (120s TTL)
        const cachedTrending = await safeCacheGet(trendingCacheKey);
        if (cachedTrending) {
            console.log(`🚀 [Redis Cache-Aside] Cache HIT for Trending feed of User #${viewerId}`);
            const cached = JSON.parse(cachedTrending);
            const filtered = Array.isArray(cached)
                ? cached.filter((post) => !blockedGraph.userIds.includes(Number(post?.user_id)))
                : cached;
            return res.json(filtered);
        }

        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const excludedAuthorIds = await getExcludedTownHallAuthorUserIds(req.user?.profile_id);

        const posts = await prisma.town_hall_post.findMany({
            where: {
                parent_id: null,
                created_at: { gte: since },
                ...(blockedGraph.userIds.length ? { user_id: { notIn: blockedGraph.userIds } } : {}),
                ...notBannedWhere(),
                ...visibleNowWhere(),
                ...notInIds('user_id', excludedAuthorIds),
            },
            take: 200,
            include: viewerInclude(viewerId),
        });

        const scored = posts
            .map(p => {
                const views = p.view_count || p._count?.views || 0;
                const likes = p._count?.likes ?? 0;
                const replies = p._count?.replies ?? 0;
                const reposts = p._count?.reposts ?? 0;

                const ageHours = (Date.now() - new Date(p.created_at).getTime()) / 3600000;
                const decay = 1 / Math.pow(ageHours + 2, 1.2);

                const rawScore = (views * 1) + (likes * 2) + (replies * 3) + (reposts * 4);
                const score = rawScore * decay;

                return { ...withViewerState(p), _trendingScore: score };
            })
            .sort((a, b) => b._trendingScore - a._trendingScore)
            .slice(0, limit);

        // Save scored trending items inside Redis Cache for 120 seconds
        await safeCacheSet(trendingCacheKey, JSON.stringify(scored), 120);
        console.log(`💾 [Redis Cache-Aside] Cached trending feed for User #${viewerId} for 120s`);

        res.json(scored);
    } catch (e) {
        console.error('Failed to fetch trending feed:', e);
        res.status(500).json({ message: 'Failed to fetch trending posts' });
    }
});


// GET /town-hall/trending-topics — X.com-style "Trending Now" hashtag list.
// Distinct from /trending above (which ranks whole POSTS by engagement):
// this extracts every #hashtag used in recent posts and ranks the TAGS
// themselves by how many times they were used, most-used first. This is
// the endpoint the home "Trending Now" widget needs — it did not exist
// before, which is why that widget had nothing real to show.
// GET /town-hall/spotlight — "Post of the Week": the single highest-engagement top-level post from
// the last 7 days. Deliberately DIFFERENT from /trending: trending is time-DECAYED (what's hot right
// now), this is un-decayed TOTAL engagement, so it surfaces the week's standout post — a complement,
// not a duplicate of the Trending tab. Registered before the bare /:id route. 300s cache.
router.get('/spotlight', authenticateToken, async (req, res) => {
    try {
        const viewerId = req.user?.user_id;
        const blockedGraph = await blockedGraphForUser(viewerId);
        const cacheKey = `townhall:spotlight:user:${viewerId}`;
        const cached = await safeCacheGet(cacheKey);
        if (cached) {
            const cachedPost = JSON.parse(cached);
            if (cachedPost?.user_id && blockedGraph.userIds.includes(Number(cachedPost.user_id))) {
                return res.json(null);
            }
            return res.json(cachedPost);
        }

        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const excludedAuthorIds = await getExcludedTownHallAuthorUserIds(req.user?.profile_id);
        const posts = await prisma.town_hall_post.findMany({
            where: {
                parent_id: null,
                created_at: { gte: since },
                ...(blockedGraph.userIds.length ? { user_id: { notIn: blockedGraph.userIds } } : {}),
                // Safety gate. This endpoint PROMOTES a single post to the top of every
                // user's Home feed and picks purely by engagement — exactly what borderline
                // content maximises — so without this a post already moderated as banned,
                // or flagged sensitive, could be auto-featured platform-wide.
                // visibleNowWhere() only checks scheduling. /trending-topics and
                // /voices-to-follow below already filter is_banned; this was missed.
                is_banned: false,
                is_sensitive: false,
                ...visibleNowWhere(),
                ...notInIds('user_id', excludedAuthorIds),
            },
            // The 200-row cap used to have NO orderBy, so once a week exceeded 200 posts
            // the "best of the week" was chosen from an arbitrary slice and the real
            // winner could be excluded outright. Order by the cheapest high-signal column
            // so the cap keeps the strongest candidates. (Prisma can't ORDER BY the
            // computed score below; view_count is the closest single-column proxy.)
            orderBy: { view_count: 'desc' },
            take: 500,
            include: viewerInclude(viewerId),
        });

        let best = null;
        let bestScore = 0;
        for (const p of posts) {
            const views = p.view_count || p._count?.views || 0;
            const likes = p._count?.likes ?? 0;
            const replies = p._count?.replies ?? 0;
            const reposts = p._count?.reposts ?? 0;

            // A view is passive, unattributable and trivially inflated; likes/replies/reposts
            // are deliberate acts. Requiring at least one real interaction is what the comment
            // below always claimed ("never surface a zero-interaction post") but never enforced
            // — `score > 0` was satisfied by views alone, so a post with 594 views and zero
            // likes/replies/reposts became Post of the Week.
            if (likes + replies + reposts < MIN_SPOTLIGHT_INTERACTIONS) continue;

            // Raw (NON-decayed) engagement — the week's best, not the freshest. Likes/reposts weighted
            // higher than a passive view; mirrors trending's fields so the same _count include works.
            const score = (views * 1) + (likes * 3) + (replies * 3) + (reposts * 4);
            if (score > bestScore) { bestScore = score; best = p; }
        }

        // Only spotlight a post with real engagement — never surface a zero-interaction post.
        const result = best ? { ...withViewerState(best), _spotlightScore: bestScore } : null;
        await safeCacheSet(cacheKey, JSON.stringify(result), 300);
        res.json(result);
    } catch (e) {
        console.error('Failed to fetch spotlight post:', e);
        res.status(500).json({ message: 'Failed to fetch spotlight post' });
    }
});
router.get('/trending-topics', authenticateToken, async (req, res) => {
    try {
        const limit = Math.min(30, parseInt(req.query.limit, 10) || 10);
        const cacheKey = `townhall:trending-topics:limit_${limit}`;

        const cached = await safeCacheGet(cacheKey);
        if (cached) {
            return res.json({ successful: true, topics: JSON.parse(cached) });
        }

        // Hashtag extraction pushed into Postgres itself (regexp_matches over
        // the last 7 days of visible, non-banned top-level posts) rather than
        // pulling hundreds of post bodies into Node to regex through — this
        // is the same kind of DB-level aggregation the home feed UNION query
        // already uses, and it scales the same way as post volume grows.
        const rows = await prisma.$queryRaw`
            SELECT LOWER(tag) AS tag, COUNT(*)::int AS count
            FROM (
                SELECT (regexp_matches(p.content, '#[A-Za-z0-9_]+', 'g'))[1] AS tag
                FROM "town_hall_post" p
                WHERE p."parent_id" IS NULL
                  AND p."is_banned" = false
                  AND p."created_at" >= NOW() - INTERVAL '7 days'
                  AND (p."scheduled_at" IS NULL OR p."scheduled_at" <= NOW())
            ) hashtags
            GROUP BY LOWER(tag)
            ORDER BY count DESC
            LIMIT ${limit}
        `;

        const topics = rows.map(r => ({ tag: r.tag, count: Number(r.count) }));

        // Same cadence as /trending — trending topics don't need to be
        // second-fresh, just fast and cheap to serve on every home load.
        await safeCacheSet(cacheKey, JSON.stringify(topics), 120);

        res.json({ successful: true, topics });
    } catch (e) {
        console.error('Failed to fetch trending topics:', e);
        res.status(500).json({ message: 'Failed to fetch trending topics' });
    }
});


// GET /town-hall/voices-to-follow — home "Voices to Follow" suggestions.
// Did not exist before, which is the root cause of the button always
// reading "Follow": there was nowhere accurate for the widget to get its
// data or its per-viewer follow state from. Suggests active accounts the
// viewer does NOT already follow (so "already following" can never render
// wrong — they're simply not suggested again), ranked by how recently the
// account posted (today's freshest voices surface first), with `is_following`
// explicitly returned on every entry for the frontend button to key off.
router.get('/voices-to-follow', authenticateToken, async (req, res) => {
    try {
        const limit = Math.min(20, parseInt(req.query.limit, 10) || 8);
        const viewerUserId = req.user?.user_id;
        const myProfileId = req.user?.profile_id;
        const blockedGraph = await blockedGraphForUser(viewerUserId);

        const followingIds = myProfileId
            ? (await prisma.follower.findMany({
                  where: { follower_id: myProfileId, status: 'accepted' },
                  select: { following_id: true },
              })).map(f => f.following_id)
            : [];

        const hiddenProfileIds = myProfileId ? await getHiddenProfileIds(myProfileId) : [];
        const excludeProfileIds = [...new Set([
            ...followingIds,
            ...hiddenProfileIds,
            ...(blockedGraph.profileIds || []),
        ].map(Number).filter(Boolean))];
        const candidates = await prisma.social_profile.findMany({
            where: {
                user_id: { not: viewerUserId },
                is_banned: false,
                is_shadow_banned: false,
                is_private: false,
                ...(excludeProfileIds.length ? { profile_id: { notIn: excludeProfileIds } } : {}),
            },
            take: 50,
            orderBy: { created_at: 'desc' },
            select: {
                profile_id: true,
                user_id: true,
                handle: true,
                display_name: true,
                profile_pic_url: true,
                is_verified: true,
                verification_type: true,
                _count: { select: { followers: true } },
                user: { select: { user_id: true, name: true, username: true } },
            },
        });

        if (candidates.length === 0) {
            return res.json({ successful: true, users: [] });
        }

        // One aggregate query for "when did each candidate last post" (today's
        // active voices) instead of N queries — this is what lets the list
        // prioritize people who posted recently, as requested.
        const candidateUserIds = candidates.map(c => c.user_id);
        const latestActivity = await prisma.town_hall_post.groupBy({
            by: ['user_id'],
            where: { user_id: { in: candidateUserIds }, parent_id: null, is_banned: false },
            _max: { created_at: true },
        });
        const lastActiveMap = new Map(latestActivity.map(r => [r.user_id, r._max.created_at]));

        // Daily-seeded shuffle (same PRNG the feed ranker uses) so ties in
        // activity/follower-count don't show the exact same order to every
        // viewer all day, while still being stable across one session.
        const rng = makeSeededRandom(`voices:${viewerUserId}:${utcDayBucket()}`);

        const ranked = candidates
            .map(c => ({
                c,
                lastActiveAt: lastActiveMap.get(c.user_id)?.getTime() ?? 0,
                followerCount: c._count?.followers ?? 0,
                jitter: rng(),
            }))
            .sort((a, b) => {
                if (b.lastActiveAt !== a.lastActiveAt) return b.lastActiveAt - a.lastActiveAt;
                if (b.followerCount !== a.followerCount) return b.followerCount - a.followerCount;
                return b.jitter - a.jitter;
            })
            .slice(0, limit)
            .map(({ c, lastActiveAt }) => ({
                user_id: c.user_id,
                name: c.user?.name,
                username: c.user?.username,
                profile_id: c.profile_id,
                handle: c.handle,
                display_name: c.display_name,
                profile_pic_url: c.profile_pic_url,
                is_verified: c.is_verified,
                verification_type: c.verification_type,
                follower_count: c._count?.followers ?? 0,
                last_active_at: lastActiveAt ? new Date(lastActiveAt).toISOString() : null,
                // Always false by construction (already-followed accounts are
                // excluded above), included explicitly so the frontend never
                // has to guess/default the button state.
                is_following: false,
            }));

        res.json({ successful: true, users: ranked });
    } catch (e) {
        console.error('Failed to fetch voices to follow:', e);
        res.status(500).json({ message: 'Failed to fetch voices to follow' });
    }
});


// GET /town-hall/user/:user_id — a single user's top-level Town Hall posts for their
// profile. The author sees their own scheduled posts; everyone else sees published only.
router.get('/user/:user_id', authenticateToken, async (req, res) => {
    try {
        const userId = parseInt(req.params.user_id);
        if (!userId || Number.isNaN(userId)) return res.status(400).json({ message: 'Invalid user_id' });
        const page     = Math.max(1, parseInt(req.query.page) || 1);
        const limit    = Math.min(100, parseInt(req.query.limit) || 50);
        const viewerId = req.user?.user_id;
        const viewerProfileId = req.user?.profile_id;

        // Private-profile authors: only self + followers can list their Town Hall posts.
        if (viewerId !== userId) {
            const blockedGraph = await blockedGraphForUser(viewerId);
            if (blockedGraph.userIds.includes(userId)) return res.status(404).json({ message: 'Not found' });
            const authorProfile = await prisma.social_profile.findUnique({
                where: { user_id: userId },
                select: { profile_id: true, is_private: true },
            });
            if (authorProfile?.is_private) {
                if (!viewerProfileId) return res.json([]);
                const follows = await prisma.follower.findFirst({
                    where: { follower_id: viewerProfileId, following_id: authorProfile.profile_id, status: 'accepted' },
                    select: { id: true },
                });
                if (!follows) return res.json([]);
            }
            if (authorProfile && viewerProfileId) {
                const hidden = await getHiddenProfileIds(viewerProfileId);
                if (hidden.includes(authorProfile.profile_id)) {
                    return res.json([]);
                }
            }
        }
        const scheduleWhere = viewerId === userId ? {} : { ...visibleNowWhere(), ...notBannedWhere() };
        const posts = await prisma.town_hall_post.findMany({
            where:   { user_id: userId, parent_id: null, ...scheduleWhere },
            orderBy: { created_at: 'desc' },
            skip:    (page - 1) * limit,
            take:    limit,
            include: viewerInclude(viewerId),
        });
        res.json(posts.map(withViewerState));
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Failed to fetch user posts' });
    }
});

// POST /town-hall/upload — upload media file, returns { url, media_type }
router.post('/upload', authenticateToken, uploadRateLimiter, upload.single('media'), async (req, res) => {
    try {
        const activeUserId = req.user?.user_id;
        if (!activeUserId) return res.status(401).json({ message: 'Unauthorized' });
        if (await isTownHallRestricted(activeUserId)) {
            return res.status(403).json({ message: 'Your account is restricted from posting on Town Hall.' });
        }

        if (!req.file) return res.status(400).json({ message: 'No file provided' });
        
        const buffer = req.file.buffer;
        let finalBuffer = buffer;
        let finalMimeType = req.file.mimetype;
        let mediaType = 'image';
        let ext = 'webp';

        // 5.2: Strictly validate magic bytes against allowed types list using your existing helper
        let verifiedTypeMeta;
        try {
            verifiedTypeMeta = await validateMime(buffer, ALLOWED_MEDIA_TYPES);
        } catch (mimeError) {
            return res.status(400).json({ message: mimeError.message || 'Invalid or insecure file format.' });
        }

        const isVideo = ALLOWED_VIDEO_TYPES.includes(verifiedTypeMeta.mime);

        if (isVideo) {
            // Strict video size validation: Limit to 50MB to protect Azure Storage bandwidth
            if (req.file.size > 50 * 1024 * 1024) {
                return res.status(400).json({ message: 'Video file size exceeds 50MB limit' });
            }
            mediaType = 'video';
            ext = verifiedTypeMeta.ext;
            finalMimeType = verifiedTypeMeta.mime;
        } else {
            // 5.3: Convert image to WebP and resize dynamically to 1280px width using your upgraded helper
            finalBuffer = await optimizeImage(buffer);
            finalMimeType = 'image/webp';
            mediaType = 'image';
            ext = 'webp';
        }

        const blobName = `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
        const containerName = TOWNHALL_MEDIA_CONTAINER;

        // Upload media asset to dedicated Town Hall Azure container
        const url = await uploadPublicBlob(
            containerName,
            blobName,
            finalBuffer,
            finalMimeType,
        );

        // 5.5: Explicitly clear Node.js memory references
        req.file.buffer = null;

        res.json({ url, media_type: mediaType });
    } catch (e) {
        console.error('Town Hall upload pipeline error:', e);
        res.status(500).json({ message: 'Upload and image optimization failed' });
    }
});

const IMPORT_BUSY = ['queued', 'listing', 'importing'];

function serializeImportJob(job) {
    if (!job) return null;
    return {
        job_id: job.job_id,
        source_url: job.source_url,
        status: job.status,
        total_found: job.total_found,
        imported_count: job.imported_count,
        skipped_count: job.skipped_count,
        failed_count: job.failed_count,
        error_message: job.error_message,
        created_at: job.created_at,
        updated_at: job.updated_at,
    };
}

/**
 * POST /town-hall/import
 * Queue a background copy of an X / Twitter profile onto this user's Town Hall.
 * Must be registered before /:id so "import" is not parsed as a post id.
 */
router.post('/import', authenticateToken, socialRateLimiter, async (req, res, next) => {
    try {
        const user_id = req.user.user_id;
        if (await isTownHallRestricted(user_id)) {
            return sendError(res, 403, req, 'townhall.errors.restricted');
        }

        const source_url = normalizeTwitterSourceUrl(req.body?.url || req.body?.source_url);

        const busy = await prisma.townhall_import_job.findFirst({
            where: { user_id, status: { in: [...IMPORT_BUSY] } },
            orderBy: { created_at: 'desc' },
        });
        if (busy) {
            return res.status(409).json({
                successful: false,
                message: 'An import is already running. You can start another when it finishes.',
                data: serializeImportJob(busy),
            });
        }

        const job = await prisma.townhall_import_job.create({
            data: { user_id, source_url, status: 'queued' },
        });

        const queued = await enqueueTownhallImport(job.job_id, 'list');
        if (!queued) {
            await prisma.townhall_import_job.update({
                where: { job_id: job.job_id },
                data: { status: 'error', error_message: 'Import queue is not configured' },
            });
            return res.status(503).json({ successful: false, message: 'Import queue is not available right now.' });
        }

        res.status(202).json({
            successful: true,
            message: 'Import started. Posts copy in the background — you can leave this page.',
            data: serializeImportJob(job),
        });
    } catch (err) {
        if (err.status === 400) {
            return res.status(400).json({ successful: false, message: err.message });
        }
        next(err);
    }
});

/** GET /town-hall/import — latest import job for this user. */
router.get('/import', authenticateToken, async (req, res, next) => {
    try {
        const job = await prisma.townhall_import_job.findFirst({
            where: { user_id: req.user.user_id },
            orderBy: { created_at: 'desc' },
        });
        res.json({ successful: true, data: serializeImportJob(job) });
    } catch (err) { next(err); }
});

// POST /town-hall — create post (supports optional scheduling)
// POST /town-hall — create post (supports strict NaN type validation & identity checks)
// POST /town-hall — create post (supports strict NaN type validation & identity checks with rate limiting)
// POST /town-hall — create post (supports strict NaN type validation, identity, and marketplace product verification)
// POST /town-hall — create post (supports strict validations, marketplace pinning, and video transcoding enqueue)
// POST /town-hall — create post (supports validations, products, and real-time socket broadcasting)
// POST /town-hall — create post (supports validations, products, and nested live polls creation)
router.post('/', authenticateToken, socialRateLimiter, profanityFilter, async (req, res) => {
    try {
        const { content, parent_id, media_url, media_type, quote_post_id, scheduled_at, product_id, poll_options } = req.body;
        
        // 15.2: Content length validation wrapped underreq.t i18n helper.
        // A post/reply may be media-only (image or video) — only require text when there is no
        // attachment (#361). Still cap text length when text is present.
        const hasMedia = !!(media_url && String(media_url).trim());
        if ((!content?.trim() && !hasMedia) || (content && content.length > 280)) {
            return sendError(res, 400, req, 'townhall.validation.content_length');
        }

        const activeUserId = req.user?.user_id;
        if (!activeUserId) {
            return sendError(res, 401, req, 'auth.errors.unauthorized');
        }

        if (await isTownHallRestricted(activeUserId)) {
            return sendError(res, 403, req, 'townhall.errors.restricted');
        }

        if (hasMedia && !isAllowedTownHallMediaUrl(media_url)) {
            return sendError(res, 400, req, 'townhall.validation.invalid_media_url');
        }
        if (hasMedia && media_type && !['image', 'video'].includes(String(media_type))) {
            return sendError(res, 400, req, 'townhall.validation.invalid_media_type');
        }

        let parsedParentId = null;
        // Hoisted out of the block below so the reply notification (further down, after the post is
        // created) can reach it. Replying to someone's post used to notify them of nothing at all.
        let parentAuthorId = null;
        if (parent_id) {
            parsedParentId = parseInt(parent_id, 10);
            if (Number.isNaN(parsedParentId)) {
                return sendError(res, 400, req, 'townhall.validation.invalid_parent_id');
            }
            // Replying to a since-deleted post violated the parent_id FK and surfaced as a 500;
            // validate the parent exists and fail cleanly with a 404 instead.
            // user_id comes along so we can notify the author without a second lookup.
            const parentExists = await prisma.town_hall_post.findUnique({
                where: { post_id: parsedParentId },
                select: { post_id: true, user_id: true, is_banned: true, scheduled_at: true },
            });
            if (!parentExists) {
                return sendError(res, 404, req, 'townhall.validation.invalid_parent_id');
            }
            if (parentExists.is_banned) {
                return sendError(res, 404, req, 'townhall.errors.not_found');
            }
            if (parentExists.scheduled_at && parentExists.scheduled_at > new Date()) {
                return sendError(res, 404, req, 'townhall.errors.not_found');
            }
            parentAuthorId = parentExists.user_id ?? null;
            if (parentAuthorId) {
                await assertNoPlatformBlockBetweenUsers(activeUserId, parentAuthorId);
            }
        }

        let parsedQuotePostId = null;
        if (quote_post_id) {
            parsedQuotePostId = parseInt(quote_post_id, 10);
            if (Number.isNaN(parsedQuotePostId)) {
                return sendError(res, 400, req, 'townhall.validation.invalid_quote_id');
            }
            const quoteTarget = await prisma.town_hall_post.findUnique({
                where: { post_id: parsedQuotePostId },
                select: { post_id: true, user_id: true, is_banned: true, scheduled_at: true },
            });
            if (!quoteTarget || quoteTarget.is_banned) {
                return sendError(res, 404, req, 'townhall.validation.invalid_quote_id');
            }
            if (quoteTarget.scheduled_at && quoteTarget.scheduled_at > new Date()) {
                return sendError(res, 404, req, 'townhall.validation.invalid_quote_id');
            }
            if (quoteTarget.user_id) {
                await assertNoPlatformBlockBetweenUsers(activeUserId, quoteTarget.user_id);
            }
        }

        let parsedProductId = null;
        if (product_id) {
            parsedProductId = parseInt(product_id, 10);
            if (Number.isNaN(parsedProductId)) {
                return sendError(res, 400, req, 'townhall.validation.invalid_product_id');
            }

            const product = await prisma.product_listing.findUnique({
                where: { listing_id: parsedProductId },
                select: { seller_id: true }
            });

            if (!product) {
                return sendError(res, 404, req, 'townhall.errors.product_not_found');
            }

            if (product.seller_id !== activeUserId) {
                return sendError(res, 403, req, 'townhall.errors.product_owner_mismatch');
            }
        }

        let pollOptionStrings = [];
        if (poll_options) {
            if (!Array.isArray(poll_options) || poll_options.length < 2 || poll_options.length > 6) {
                return sendError(res, 400, req, 'townhall.validation.poll_limit');
            }
            pollOptionStrings = poll_options.filter(opt => opt && String(opt).trim());
            if (pollOptionStrings.length !== poll_options.length) {
                return sendError(res, 400, req, 'townhall.validation.poll_empty_option');
            }
            if (pollOptionStrings.some(opt => String(opt).trim().length > 100)) {
                return sendError(res, 400, req, 'townhall.validation.poll_option_too_long');
            }
        }

        let scheduledAt = null;
        if (scheduled_at) {
            const d = new Date(scheduled_at);
            if (!Number.isNaN(d.getTime()) && d.getTime() > Date.now()) scheduledAt = d;
        }

        const post = await prisma.town_hall_post.create({
            data: {
                user_id:       activeUserId,
                content:       content?.trim() || '',
                parent_id:     parsedParentId,
                media_url:     hasMedia ? String(media_url).trim() : null,
                media_type:    hasMedia ? (media_type ?? null) : null,
                quote_post_id: parsedQuotePostId,
                scheduled_at:  scheduledAt,
                product_id:    parsedProductId,
                ...(pollOptionStrings.length > 0 && {
                    poll_options: {
                        create: pollOptionStrings.map(text => ({ option_text: text.trim() }))
                    }
                })
            },
            include: POST_INCLUDE,
        });

        // #415: hand the video to the same strug_worker pipeline the Videos vertical uses, so the
        // post gets an HLS rendition + a poster thumbnail instead of playing the raw upload.
        //
        // This enqueue already existed but was BROKEN, and dangerously so: the worker never read
        // `type`, so it took post_id as a video_id. If no video had that id it silently no-op'd
        // (the post kept playing the raw file — bug #415); if one DID, the worker transcoded and
        // OVERWROTE that unrelated video's row. The worker is now type-aware, and the message
        // carries everything it needs to find the blob.
        if (post.media_type === 'video' && post.media_url) {
            try {
                // Dispatch video transcode task targeting dedicated Town Hall container
                await pushToVideoQueue(post.post_id, blobNameFromUrl(post.media_url), {
                    type: 'townhall',
                    container: TOWNHALL_MEDIA_CONTAINER,
                    lane: 'bulk',
                });
                await prisma.town_hall_post.update({
                    where: { post_id: post.post_id },
                    data: { processing_status: 'pending' },
                }).catch(() => {});
            } catch (queueErr) {
                console.error('[video-pipeline] Failed to enqueue townhall video transcode:', queueErr.message);
            }
        }

        const io = req.app.get('io');
        if (io) {
            const visibleNow = !post.scheduled_at || post.scheduled_at <= new Date();
            const authorProfile = await prisma.social_profile.findUnique({
                where: { user_id: activeUserId },
                select: { is_private: true },
            });
            if (visibleNow && !authorProfile?.is_private) {
                const hydratedResponse = withViewerState(post);
                io.to(`user-${activeUserId}`).emit('townhall-post-created', hydratedResponse);
            }
        }

        // Tell the parent's author someone replied to them. Guard against self-replies — being
        // notified of your own comment on your own thread is noise, not a notification.
        if (parentAuthorId && parentAuthorId !== activeUserId) {
            notify(io, {
                userId: parentAuthorId,
                actorUserId: activeUserId,
                vertical: 'townhall',
                type: 'townhall.reply',
                title: `${req.user.name || 'Someone'} replied to your Town Hall post`,
                body: post.content ? String(post.content).slice(0, 140) : null,
                urgency: 'ambient',
                entityType: 'town_hall_post',
                entityId: post.post_id,
                actionUrl: 'social',
            });
        }

        await invalidateTownHallCache();
        
        // 15.2: SendLocalized success response directly via i18n sendSuccess helper
        return sendSuccess(res, req, 'townhall.success.created', { ...post, user: normalizeAuthor(post.user) });
    } catch (e) {
        console.error('Prisma Post Creation Error:', e);
        return sendError(res, 500, req, 'townhall.errors.create_failed');
    }
});

// save post
router.post('/save', authenticateToken, engagementRateLimiter, async (req, res) => {
    try {
        const post_id = parseInt(req.body.post_id, 10);
        const user_id = req.user.user_id;

        if (!Number.isInteger(post_id)) {
            return res.status(400).json({ message: 'Valid post_id is required' });
        }

        // Check if already saved
        const existingSave = await prisma.town_hall_post_save.findUnique({
            where: { post_id_user_id: { post_id, user_id } }
        });

        if (existingSave) {
            // Unsave: Delete the record
            await prisma.town_hall_post_save.delete({
                where: { save_id: existingSave.save_id }
            });
            return res.json({ saved: false });
        }

        const post = await prisma.town_hall_post.findUnique({
            where: { post_id },
            select: { post_id: true, user_id: true, is_banned: true, scheduled_at: true },
        });
        const gate = assertPostEngageable(post);
        if (!gate.ok) return res.status(gate.status).json({ message: gate.message });
        await assertNoPlatformBlockBetweenUsers(user_id, post.user_id);

        await prisma.town_hall_post_save.create({
            data: { post_id, user_id }
        });

        await invalidateViewerTownHallCache(user_id);
        return res.json({ saved: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Failed to toggle save' });
    }
});

// DELETE /town-hall/:id — own posts and administrator/moderator deletion support.
// Replies are deleted with the parent (not promoted to top-level via parent_id = null).
router.delete('/:id', authenticateToken, async (req, res) => {
    try {
        const post_id = parseInt(req.params.id, 10);
        if (Number.isNaN(post_id)) return res.status(400).json({ message: 'Invalid id' });

        const post = await prisma.town_hall_post.findUnique({ where: { post_id } });
        if (!post) return res.status(404).json({ message: 'Post not found' });
        
        // Role check: Allow deletion if original author, ADMIN or MODERATOR
        const isAuthor = post.user_id === req.user.user_id;
        const isAdminOrMod = req.user.role === 'ADMIN' || req.user.role === 'MODERATOR' || req.user.permission === 'admin';

        if (!isAuthor && !isAdminOrMod) {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to delete this post.' });
        }

        const replyIds = await collectDescendantReplyIds(post_id);
        // Delete deepest replies first so self-referential parent_id FKs don't block.
        const deleteOrder = [...replyIds].reverse();
        const allIds = [...deleteOrder, post_id];

        await prisma.$transaction(async (tx) => {
            // Quotes of anything in this thread become unlinked (quote card disappears).
            await tx.town_hall_post.updateMany({
                where: { quote_post_id: { in: allIds } },
                data: { quote_post_id: null },
            });

            for (const id of deleteOrder) {
                await tx.town_hall_post.delete({ where: { post_id: id } });
            }
            await tx.town_hall_post.delete({ where: { post_id } });
        });

        await invalidateTownHallCache();
        res.json({ successful: true });
        
    } catch (e) {
        console.error('Failed to delete post:', e);
        res.status(500).json({ message: 'Failed to delete post' });
    }
});

// POST /town-hall/:id/like — toggle like
// POST /town-hall/:id/like — toggle like with real-time database-backed notifications
router.post('/:id/like', authenticateToken, engagementRateLimiter, async (req, res) => {
    try {
        const post_id = parseInt(req.params.id, 10);
        const user_id = req.user.user_id;
        const senderProfileId = req.user.profile_id;
        
        if (Number.isNaN(post_id)) return res.status(400).json({ message: 'Invalid id' });

        const post = await prisma.town_hall_post.findUnique({
            where: { post_id },
            select: { user_id: true, is_banned: true, scheduled_at: true }
        });
        if (!post) return res.status(404).json({ message: 'Post not found' });

        const existing = await prisma.town_hall_post_like.findUnique({
            where: { post_id_user_id: { post_id, user_id } },
        });

        let liked = false;
        if (existing) {
            await prisma.town_hall_post_like.delete({ where: { like_id: existing.like_id } });
            liked = false;
        } else {
            const gate = assertPostEngageable(post);
            if (!gate.ok) return res.status(gate.status).json({ message: gate.message });
            await assertNoPlatformBlockBetweenUsers(user_id, post.user_id);
            await prisma.town_hall_post_like.create({ data: { post_id, user_id } });
            liked = true;
        }

        const count = await prisma.town_hall_post_like.count({ where: { post_id } });

        // Purge the liker's cached feed pages + spotlight so their like actually persists on
        // reload (the per-user feed cache bakes in this viewer's `liked` state and the count).
        await invalidateViewerTownHallCache(user_id);

        // 8.3 & 8.4: Trigger real-time web-socket updates and persistent DB notifications
        const io = req.app.get('io');
        if (io) {
            // Live broadcast the new like count to feed viewers
            io.emit('townhall-post-updated', { post_id, likes: count });

            // If a new like is cast and the liker is not the author, trigger database notification and live socket push
            if (liked && post.user_id !== user_id) {
                const authorProfile = await prisma.social_profile.findUnique({
                    where: { user_id: post.user_id },
                    select: { profile_id: true }
                });

                if (authorProfile && senderProfileId && authorProfile.profile_id !== senderProfileId) {
                    // Persist notification securely in PostgreSQL
                    await prisma.social_notification.create({
                        data: {
                            receiver_id: authorProfile.profile_id,
                            sender_id: senderProfileId,
                            type: 'LIKE',
                            target_id: post_id
                        }
                    }).catch(err => console.error('[Notification-DB] Fail-open error:', err.message));

                    // Push live notification down to the author's private socket room
                    io.to(`user-${post.user_id}`).emit('social-notification', {
                        type: 'LIKE',
                        sender_id: user_id,
                        target_id: post_id,
                        message: `${req.user.name || 'Someone'} liked your Town Hall post.`
                    });
                    // post.user_id is already the author's user_id — no profile_id hop needed here.
                    notify(io, {
                        userId: post.user_id,
                        actorUserId: user_id,
                        vertical: 'townhall',
                        type: 'townhall.like',
                        title: `${req.user.name || 'Someone'} liked your Town Hall post`,
                        urgency: 'ambient',
                        entityType: 'town_hall_post',
                        entityId: post_id,
                        actionUrl: 'social',
                    });
                }
            }
        }

        res.json({ liked });
    } catch (e) {
        console.error('Failed to toggle like:', e);
        res.status(500).json({ message: 'Failed to toggle like' });
    }
});

// GET /town-hall/:id/replies — replies for a post (asc so thread reads top-to-bottom)
// #1200: 404 if the parent is not visible to the viewer, then list children.
router.get('/:id/replies', authenticateToken, async (req, res) => {
    try {
        const parent_id = parseInt(req.params.id, 10);
        const loaded = await loadVisibleParentOrGate(req, parent_id);
        if (!loaded.ok) return res.status(loaded.status).json({ message: loaded.message });
        const { blockedGraph } = loaded;
        const replies   = await prisma.town_hall_post.findMany({
            where:   { parent_id, ...notBannedWhere(), ...(blockedGraph.userIds.length ? { user_id: { notIn: blockedGraph.userIds } } : {}) },
            orderBy: { created_at: 'asc' },
            include: POST_INCLUDE,
        });
        res.json(replies.map(r => ({ ...r, user: normalizeAuthor(r.user) })));
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Failed to fetch replies' });
    }
});

// POST /town-hall/:id/repost — toggle repost, returns updated count
// POST /town-hall/:id/repost — toggle repost with real-time persistent notifications
router.post('/:id/repost', authenticateToken, engagementRateLimiter, async (req, res) => {
    try {
        const post_id = parseInt(req.params.id, 10);
        const user_id = req.user.user_id;
        const senderProfileId = req.user.profile_id;
        
        if (Number.isNaN(post_id)) return res.status(400).json({ message: 'Invalid id' });

        const post = await prisma.town_hall_post.findUnique({
            where: { post_id },
            select: { user_id: true, is_banned: true, scheduled_at: true }
        });
        if (!post) return res.status(404).json({ message: 'Post not found' });

        const existing = await prisma.town_hall_repost.findUnique({
            where: { post_id_user_id: { post_id, user_id } },
        });

        let reposted = false;
        if (existing) {
            await prisma.town_hall_repost.delete({ where: { repost_id: existing.repost_id } });
            reposted = false;
        } else {
            const gate = assertPostEngageable(post);
            if (!gate.ok) return res.status(gate.status).json({ message: gate.message });
            await assertNoPlatformBlockBetweenUsers(user_id, post.user_id);
            await prisma.town_hall_repost.create({ data: { post_id, user_id } });
            reposted = true;
        }

        const count = await prisma.town_hall_repost.count({ where: { post_id } });

        // 8.3 & 8.4: Push real-time socket events and persist notification row
        const io = req.app.get('io');
        if (io) {
            // Live broadcast the new repost count to the feed
            io.emit('townhall-post-updated', { post_id, reposts: count });

            if (reposted && post.user_id !== user_id) {
                const authorProfile = await prisma.social_profile.findUnique({
                    where: { user_id: post.user_id },
                    select: { profile_id: true }
                });

                if (authorProfile && senderProfileId && authorProfile.profile_id !== senderProfileId) {
                    // Persist notification row
                    await prisma.social_notification.create({
                        data: {
                            receiver_id: authorProfile.profile_id,
                            sender_id: senderProfileId,
                            type: 'REPOST',
                            target_id: post_id
                        }
                    }).catch(err => console.error('[Notification-DB] Fail-open error:', err.message));

                    // Push live notification
                    io.to(`user-${post.user_id}`).emit('social-notification', {
                        type: 'REPOST',
                        sender_id: user_id,
                        target_id: post_id,
                        message: `${req.user.name || 'Someone'} reposted your Town Hall post.`
                    });
                    notify(io, {
                        userId: post.user_id,
                        actorUserId: user_id,
                        vertical: 'townhall',
                        type: 'townhall.repost',
                        title: `${req.user.name || 'Someone'} reposted your Town Hall post`,
                        urgency: 'ambient',
                        entityType: 'town_hall_post',
                        entityId: post_id,
                        actionUrl: 'social',
                    });
                }
            }
        }

        await invalidateTownHallCache();
        res.json({ reposted, count });
    } catch (e) {
        console.error('Failed to toggle repost:', e);
        res.status(500).json({ message: 'Failed to toggle repost' });
    }
});

// GET /town-hall/:id/quotes — quote-posts of a given post
// #1200: 404 if the quoted parent is not visible to the viewer, then list children.
router.get('/:id/quotes', authenticateToken, async (req, res) => {
    try {
        const post_id = parseInt(req.params.id, 10);
        const loaded = await loadVisibleParentOrGate(req, post_id);
        if (!loaded.ok) return res.status(loaded.status).json({ message: loaded.message });
        const quotes  = await prisma.town_hall_post.findMany({
            where:   { quote_post_id: post_id, ...notBannedWhere() },
            orderBy: { created_at: 'desc' },
            include: POST_INCLUDE,
        });
        res.json(quotes.map(q => ({ ...q, user: normalizeAuthor(q.user) })));
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Failed to fetch quotes' });
    }
});

// POST /town-hall/:id/view — increment view counter (best-effort; author's own views ignored).
// POST /town-hall/:id/view — increment view counter atomically (anti-fraud enabled)
router.post('/:id/view', authenticateToken, engagementRateLimiter, async (req, res) => {
    try {
        const post_id = parseInt(req.params.id, 10);
        const user_id = req.user.user_id;
        if (Number.isNaN(post_id)) return res.status(400).json({ message: 'Invalid id' });

        const post = await prisma.town_hall_post.findUnique({ 
            where: { post_id },
            select: { user_id: true, is_banned: true, scheduled_at: true } 
        });
        
        const gate = assertPostEngageable(post);
        if (!gate.ok) return res.status(gate.status).json({ message: gate.message });

        if (post.user_id !== user_id) {
            // Deduped view: concurrent opens (React Strict Mode / double fetch) can race
            // past findUnique → create and hit unique(post_id, user_id). Use createMany
            // skipDuplicates so only the first insert counts + increments.
            await prisma.$transaction(async (tx) => {
                const inserted = await tx.town_hall_post_view.createMany({
                    data: [{ post_id, user_id }],
                    skipDuplicates: true,
                });
                if (inserted.count > 0) {
                    await tx.town_hall_post.update({
                        where: { post_id },
                        data: { view_count: { increment: 1 } },
                    });
                }
            });
        }

        const updatedPost = await prisma.town_hall_post.findUnique({
            where: { post_id },
            select: { view_count: true }
        });

        res.json({ view_count: updatedPost?.view_count || 0 });
    } catch (e) {
        console.error("Failed to record view:", e);
        res.status(500).json({ message: 'Failed to record view' });
    }
});

// GET /town-hall/public/:id — unauthenticated post fetch for cold-load / OG prerender.
// Must be registered before the bare /:id route. Hides banned + future-scheduled posts.
router.get('/public/:id', async (req, res) => {
    try {
        const post_id = parseInt(req.params.id, 10);
        if (!post_id || Number.isNaN(post_id)) {
            return res.status(400).json({ successful: false, message: 'Invalid id' });
        }

        const post = await prisma.town_hall_post.findUnique({
            where: { post_id },
            include: POST_INCLUDE,
        });

        const gate = await assertParentVisibleToViewer(post);
        if (!gate.ok) return res.status(404).json({ successful: false, message: 'Post not found' });

        res.json(toPublicPost(post));
    } catch (e) {
        console.error('Failed to fetch public post:', e);
        res.status(500).json({ successful: false, message: 'Failed to fetch post' });
    }
});

// GET /town-hall/:id — single post detail (deep link / page refresh support).
// Registered LAST so the bare :id param never shadows literal routes above (/following, /trending, etc.).
router.get('/:id', authenticateToken, async (req, res) => {
    try {
        const post_id = parseInt(req.params.id, 10);
        if (!post_id || Number.isNaN(post_id)) return sendError(res, 400, req, 'townhall.validation.invalid_id');
        
        const viewerId = req.user?.user_id;
        const blockedGraph = await blockedGraphForUser(viewerId);
        const post = await prisma.town_hall_post.findUnique({
            where: { post_id },
            include: viewerInclude(viewerId),
        });
        
        const gate = await assertParentVisibleToViewer(post, {
            viewerId,
            viewerProfileId: req.user?.profile_id ?? null,
            blockedUserIds: blockedGraph.userIds,
        });
        if (!gate.ok) return sendError(res, gate.status, req, 'townhall.errors.not_found');
        res.json(withViewerState(post));
    } catch (e) {
        console.error('Failed to fetch post details:', e);
        return sendError(res, 500, req, 'townhall.errors.fetch_failed');
    }
});

// POST /town-hall/:id/poll/vote — Cast vote on poll options securely (Anti-double voting transaction)
router.post('/:id/poll/vote', authenticateToken, engagementRateLimiter, async (req, res) => {
    try {
        const post_id = parseInt(req.params.id, 10);
        const option_id = parseInt(req.body.option_id, 10);
        const user_id = req.user.user_id;

        if (Number.isNaN(post_id) || Number.isNaN(option_id)) {
            return res.status(400).json({ message: 'Invalid id or option_id format' });
        }

        const post = await prisma.town_hall_post.findUnique({
            where: { post_id },
            select: { post_id: true, is_banned: true, scheduled_at: true, user_id: true },
        });
        const gate = assertPostEngageable(post);
        if (!gate.ok) return res.status(gate.status).json({ message: gate.message });

        // 12.1 & 12.3: Atomic transaction + unique(post_id, user_id) prevents concurrent double votes.
        // Use raw SQL for the vote write so uniqueness is enforced even if Prisma Client is briefly
        // behind the schema (generate locked while the API process holds the query engine DLL).
        await prisma.$transaction(async (tx) => {
            // 1. Confirm option exists and is mapped to the targeted post
            const option = await tx.town_hall_poll_option.findFirst({
                where: { option_id, post_id }
            });

            if (!option) {
                throw new Error("INVALID_OPTION");
            }

            // 2. Validate double voting: A user cannot cast multiple votes on a single poll
            const existing = await tx.$queryRaw`
                SELECT vote_id FROM town_hall_poll_vote
                WHERE post_id = ${post_id} AND user_id = ${user_id}
                LIMIT 1`;

            if (existing?.length) {
                throw new Error("ALREADY_VOTED");
            }

            // 3. Insert — UNIQUE(post_id, user_id) is the real concurrency guard
            try {
                await tx.$executeRaw`
                    INSERT INTO town_hall_poll_vote (option_id, user_id, post_id)
                    VALUES (${option_id}, ${user_id}, ${post_id})`;
            } catch (insertErr) {
                // Postgres unique_violation
                if (insertErr?.code === 'P2002' || insertErr?.meta?.code === '23505' || /unique|duplicate/i.test(insertErr?.message || '')) {
                    throw new Error("ALREADY_VOTED");
                }
                // Prisma wraps some driver errors
                if (insertErr?.code === '23505') throw new Error("ALREADY_VOTED");
                throw insertErr;
            }
        });

        // 12.5: Broadcast live updated percentages dynamically via Socket.IO directly
        const io = req.app.get('io');
        if (io) {
            const updatedOptions = await prisma.town_hall_poll_option.findMany({
                where: { post_id },
                include: { _count: { select: { votes: true } } }
            });
            
            io.emit('townhall-poll-updated', {
                post_id,
                options: updatedOptions.map(o => ({
                    option_id: o.option_id,
                    votes_count: o._count.votes
                }))
            });
        }

        await invalidateTownHallCache();
        res.status(201).json({ successful: true });
    } catch (e) {
        if (e.message === "INVALID_OPTION") {
            return res.status(404).json({ message: 'Selected option not found for this poll.' });
        }
        if (e.message === "ALREADY_VOTED" || e.code === 'P2002') {
            return res.status(400).json({ message: 'You have already voted on this poll.' });
        }
        console.error('Failed to cast vote:', e);
        res.status(500).json({ message: 'Failed to cast vote' });
    }
});

// =====================================================================
// PRODUCTION-GRADE DEEP LINKING & SEO OPEN GRAPH PREVIEW GENERATOR
// =====================================================================

// List of social media preview and search engine crawler bot User-Agents
const CRAWLER_USER_AGENTS = [
    'facebookexternalhit',
    'twitterbot',
    'googlebot',
    'bingbot',
    'linkedinbot',
    'whatsapp',
    'telegrambot',
    'discordbot',
    'slackbot',
    'vkshare',
    'w3c_validator'
];

/**
 * GET /town-hall/share/:id — Universal Deep Link endpoint.
 * Serves optimized HTML metadata shell to Crawler Bots, and redirects real users to Mobile App/Web app fallback.
 */
router.get('/share/:id', async (req, res) => {
    try {
        const post_id = parseInt(req.params.id, 10);
        if (Number.isNaN(post_id)) return res.status(400).json({ message: 'Invalid id format' });

        const post = await prisma.town_hall_post.findUnique({
            where: { post_id },
            include: {
                user: { select: AUTHOR_SELECT }
            }
        });

        const shareGate = await assertParentVisibleToViewer(post);
        if (!shareGate.ok) {
            return res.status(404).send('Post not found');
        }

        const userAgent = (req.headers['user-agent'] || '').toLowerCase();
        const isCrawler = CRAWLER_USER_AGENTS.some(bot => userAgent.includes(bot));

        // All of these land in the HTML shell below, so escape the user-controlled ones (name,
        // username, content, media_url) to prevent stored XSS via a crafted post/profile.
        const authorName = escapeHtml(post.user?.name || 'Someone');
        const authorHandle = post.user?.username ? `@${escapeHtml(post.user.username)}` : 'Strug User';
        const postContent = escapeHtml(post.content || '');
        const postTitle = `${authorName} (${authorHandle}) on Town Hall`;

        // 13.8: Define image preview (Default branding logo, WebP optimized image, or video thumbnail placeholder)
        const previewImage = escapeHtml(post.media_url || 'https://ststrugproduploads.blob.core.windows.net/social-posts/branding/strug-og-logo.png');
        const shareUrl = `https://strug.ca/town-hall/share/${post_id}`;

        // 13.3: Serving pre-rendered HTML metadata explicitly to crawlers (Saves huge CPU overhead!)
        if (isCrawler) {
            console.log(`🤖 [SEO Crawler Detected] Serving metadata shell to: ${req.headers['user-agent']}`);
            
            // 13.2 & 13.10: Dynamic Open Graph card payload with high-contrast presentation styling
            const htmlShell = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="utf-8">
                <title>${postTitle}</title>
                
                <!-- Open Graph / Facebook -->
                <meta property="og:type" content="article">
                <meta property="og:url" content="${shareUrl}">
                <meta property="og:title" content="${postTitle}">
                <meta property="og:description" content="${postContent}">
                <meta property="og:image" content="${previewImage}">
                <meta property="og:site_name" content="Strug Town Hall">
                
                <!-- Twitter / X -->
                <meta name="twitter:card" content="summary_large_image">
                <meta name="twitter:url" content="${shareUrl}">
                <meta name="twitter:title" content="${postTitle}">
                <meta name="twitter:description" content="${postContent}">
                <meta name="twitter:image" content="${previewImage}">
                
                <!-- Telegram / WhatsApp styling hints -->
                <meta name="theme-color" content="#0F172A">
                
                <style>
                    body {
                        background-color: #0F172A;
                        color: #F8FAFC;
                        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        height: 100vh;
                        margin: 0;
                    }
                    .preview-card {
                        background-color: #1E293B;
                        border-radius: 12px;
                        padding: 24px;
                        max-width: 500px;
                        border: 1px solid #334155;
                        box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.3);
                    }
                    .author {
                        font-weight: bold;
                        color: #F59E0B;
                        margin-bottom: 8px;
                    }
                    .content {
                        font-size: 16px;
                        line-height: 1.5;
                    }
                </style>
            </head>
            <body>
                <div class="preview-card">
                    <div class="author">${authorName} (${authorHandle})</div>
                    <div class="content">${postContent}</div>
                </div>
            </body>
            </html>
            `;
            res.setHeader('Content-Type', 'text/html');
            return res.send(htmlShell);
        }

        // 13.5 & 13.6: Real User redirection. Handshakes with Mobile App URI scheme and falls back to Web App
        console.log(`📱 [Real User Detected] Redirecting to Universal Deep Link for Post #${post_id}`);
        
        // Dynamic tracking UTM tags for analytics. utm_source is attacker-controlled and lands
        // both inside a <script> string and an href, so restrict it to a safe token allowlist
        // ([A-Za-z0-9_-], capped) — this closes the reflected-XSS via the redirect shell.
        const utmSource = (String(req.query.utm_source || 'social_share').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)) || 'social_share';
        const webFallbackUrl = `https://app.strug.ca/townhall/${post_id}?utm_source=${utmSource}`;

        const redirectShell = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Opening Strug...</title>
            <script>
                // Attempt to open the custom URI scheme in mobile devices
                window.location.href = "strug://town-hall/${post_id}?utm_source=${utmSource}";
                
                // Set fallback timeout: If the app isn't installed, redirect to web-app after 2.5 seconds
                setTimeout(function() {
                    window.location.href = "${webFallbackUrl}";
                }, 2500);
            </script>
        </head>
        <body>
            <p style="text-align: center; font-family: sans-serif; padding-top: 50px;">
                Redirecting to Strug App... If it doesn't open, <a href="${webFallbackUrl}">click here to open in browser</a>.
            </p>
        </body>
        </html>
        `;
        
        res.setHeader('Content-Type', 'text/html');
        res.send(redirectShell);

    } catch (e) {
        console.error('Deep link sharing router failed:', e);
        res.status(500).json({ message: 'Internal server error' });
    }
});


export default router;
