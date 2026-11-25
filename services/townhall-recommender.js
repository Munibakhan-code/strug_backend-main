import prisma from '../utils/prisma-client.js';

// =====================================================================
// TOWN HALL PERSONALIZED FEED RANKER
// ---------------------------------------------------------------------
// 14.1  FIX — "same author back-to-back" bug
// The old interleaver grouped posts by author, sorted each bucket, then
// walked round-by-round taking index[i] from every author's bucket. That
// only works while every author still has a post left at index i. The
// moment one author (e.g. a dummy account that just posted 20 in a row)
// has far more posts than everyone else, every other bucket empties out
// early — and every remaining round contains just that one author, so
// their posts land back-to-back at the tail of the feed. This is exactly
// the reported bug: one user's posts, then the next user's posts, stacked.
//
// This version replaces it with a greedy, cooldown-aware selector (the
// same family of algorithm behind "Task Scheduler" / "Rearrange String k
// Distance Apart"): at every step it takes the highest-scoring remaining
// post whose author hasn't appeared in the last N picks. It also hard-caps
// how many posts any single author can contribute to one page, so a
// posting burst can never dominate the feed even in the pathological case
// where it's the only content available.
//
// 14.2  FIX — follow-boost silently never applied
// `post.user?.social_profiles?.[0]?.profile_id` was reading array index 0
// off a to-ONE Prisma relation (social_profile.user_id is @unique), which
// Prisma returns as a single object, not an array. `[0]` on a plain object
// is always `undefined`, so `socialMultiplier` never actually triggered.
// Fixed to read `.profile_id` directly.
//
// 14.3  FIX — feed re-shuffled on every request, breaking pagination
// The old code called Math.random() per post per request, so the exact
// same DB state could rank differently every time it was requested —
// meaning a slow-scrolling user could see the same post twice across two
// pages, or miss one entirely. Jitter is now seeded off (userId + UTC
// date), so a user's ranking is stable while they browse a page, and
// reshuffles once a day — which is also literally what "randomize daily"
// means, instead of reshuffling on every single call.
// =====================================================================

const INTEREST_WEIGHT = 5.0;
const SEARCH_WEIGHT = 3.0;
const AUTHORED_HASHTAG_WEIGHT = 4.0;
const FOLLOW_MULTIPLIER = 1.5;
const TIME_DECAY_GRAVITY = 1.2;
const SEEN_PENALTY_MULTIPLIER = 0.1;

// Same spread as before — just deterministic now instead of Math.random().
const MIN_JITTER = 1.0;
const MAX_JITTER = 1.3;

// --- Author-diversity controls -----------------------------------------
// No single author can supply more than `maxAuthorShare` of a page (clamped
// between minAuthorCap/maxAuthorCap), and no two posts from the same author
// can land within `cooldownWindow` slots of each other.
const DEFAULT_MAX_AUTHOR_SHARE = 0.12;
const DEFAULT_MIN_AUTHOR_CAP = 3;
const DEFAULT_MAX_AUTHOR_CAP = 15;
const DEFAULT_COOLDOWN = 4;

// =====================================================================
// Deterministic per-(user, day) PRNG — mulberry32, seeded from a small
// string hash. No external dependency needed for this.
// =====================================================================
function seedFromString(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
        h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
        h = (h << 13) | (h >>> 19);
    }
    return (h ^ (h >>> 16)) >>> 0;
}

export function makeSeededRandom(seedString) {
    let state = seedFromString(seedString) || 0x9e3779b9;
    return function seededRandom() {
        state |= 0;
        state = (state + 0x6D2B79F5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// UTC day bucket, e.g. "2026-07-06" — feed identity rotates at UTC midnight.
export function utcDayBucket(date = new Date()) {
    return date.toISOString().slice(0, 10);
}

// Lowercased hashtag tokens found in a block of text, e.g. "#SriLanka" -> "#srilanka".
// Shared by scoring (authored-hashtag signal), trending topics, and interest matching.
export function extractHashtags(text) {
    return (String(text || '').toLowerCase().match(/#[a-zA-Z0-9_]+/g)) || [];
}

// 16.1 FIX — jitter must be a pure function of (seedString, post_id), never
// of a post's position in whatever candidate array happens to be in memory.
// The old code drew jitter from ONE shared, sequentially-advancing RNG
// (`rng()` called once per post, in array order), so a post's jitter — and
// therefore its score and rank — depended on how many OTHER posts were
// scored ahead of it that call. That was fine only as long as the
// candidate window never changed shape between requests. But the feed's
// personalization window intentionally WIDENS as a user scrolls deeper
// (more candidates get pulled in from the DB), which shifts every other
// post's index in the sequence and silently re-sorts pages the user
// already scrolled past — duplicates and skipped posts mid-scroll. Keying
// the jitter off the post's own id makes it independent of window size or
// composition: a post's jitter (and rank) can now only change when the
// day rotates, never because more candidates got added around it.
export function jitterForPost(seedString, postId) {
    const rng = makeSeededRandom(`${seedString}:jitter:${postId}`);
    return rng() * (MAX_JITTER - MIN_JITTER) + MIN_JITTER;
}

// =====================================================================
// Per-viewer personalization context: interests, recent search keywords,
// who they follow, and what they've already seen. Fetched once per feed
// build and reused across every candidate post being scored.
// =====================================================================
export async function getUserPersonalizationContext(userId) {
    const profile = await prisma.social_profile.findUnique({
        where: { user_id: userId },
        select: { profile_id: true }
    });
    if (!profile) {
        return {
            profileId: null,
            interestPatterns: [],
            keywordPatterns: [],
            authoredHashtagPatterns: [],
            following: new Set(),
            seenIds: new Set()
        };
    }
    const profileId = profile.profile_id;
    const [interestRecord, searchRecords, followingRecords, seenRecords, authoredPosts] = await Promise.all([
        prisma.user_interest_profile.findUnique({
            where: { profile_id: profileId },
            select: { interests: true }
        }).catch(() => null),
        prisma.social_search_history.findMany({
            where: { profile_id: profileId },
            take: 10,
            orderBy: { created_at: 'desc' },
            select: { query: true }
        }).catch(() => []),
        prisma.follower.findMany({
            where: { follower_id: profileId },
            select: { following_id: true }
        }).catch(() => []),
        prisma.content_impression.findMany({
            where: { profile_id: profileId, content_type: 'POST' },
            select: { content_id: true }
        }).catch(() => []),
        // 16.2: the viewer's OWN recent hashtag usage — a direct, first-party
        // interest signal that needs no separate offline job to populate.
        prisma.town_hall_post.findMany({
            where: { user_id: userId, is_banned: false },
            orderBy: { created_at: 'desc' },
            take: 200,
            select: { content: true }
        }).catch(() => [])
    ]);

    const interests = interestRecord?.interests && typeof interestRecord.interests === 'object'
        ? interestRecord.interests
        : {};

    // Compile match patterns ONCE per request (not once per post-per-tag like
    // before) — reused across every candidate post scored in this build.
    const interestPatterns = Object.entries(interests)
        .map(([rawTag, weight]) => {
            const tag = cleanToken(rawTag);
            if (!tag) return null;
            return { tag, weight: Number(weight) || 0, regex: wordBoundaryRegex(tag) };
        })
        .filter(Boolean);

    const keywordSet = new Set();
    for (const r of searchRecords) {
        for (const word of r.query.toLowerCase().trim().split(/\s+/)) {
            if (word.length > 2) keywordSet.add(word);
        }
    }
    const keywordPatterns = [...keywordSet].map(word => ({ word, regex: wordBoundaryRegex(word) }));

    const following = new Set(followingRecords.map(f => f.following_id));
    const seenIds = new Set(seenRecords.map(s => s.content_id));

    // 16.2: Rank the viewer's own hashtags by how often THEY use them (not
    // how often anyone else does). Top 25 is plenty of signal and keeps
    // per-post scoring cheap regardless of how prolific the poster is.
    const hashtagCounts = new Map();
    for (const post of authoredPosts) {
        for (const tag of extractHashtags(post.content)) {
            hashtagCounts.set(tag, (hashtagCounts.get(tag) || 0) + 1);
        }
    }
    const authoredHashtagPatterns = [...hashtagCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 25)
        .map(([tag, count]) => ({ tag, weight: 1 + Math.log2(count) }));

    return { profileId, interestPatterns, keywordPatterns, authoredHashtagPatterns, following, seenIds };
}

function cleanToken(str) {
    return String(str || '').replace(/[^a-zA-Z0-9_#]/g, '').trim().toLowerCase();
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wordBoundaryRegex(token) {
    // '#' isn't a \w character so \b won't anchor correctly in front of a
    // hashtag token — match those as a plain substring instead.
    if (token.startsWith('#')) {
        return new RegExp(escapeRegex(token));
    }
    return new RegExp(`\\b${escapeRegex(token)}\\b`);
}

// =====================================================================
// Scoring
// ---------------------------------------------------------------------
// `candidate` shape: { post_id, content, created_at, likes, replies,
//   reposts, authorProfileId }
// `rng` MUST be the same seeded-random instance for every post in one
// feed build (pass it in from the caller) so jitter is deterministic for
// the whole page rather than reshuffling mid-scroll.
// =====================================================================
export function scoreCandidate(candidate, context, seedString) {
    const now = Date.now();
    const createdTime = new Date(candidate.created_at).getTime();
    const ageHours = Math.max(0, (now - createdTime) / 3600000);
    const likes = candidate.likes ?? 0;
    const replies = candidate.replies ?? 0;
    const reposts = candidate.reposts ?? 0;

    const baseScore = (likes * 2) + (replies * 3) + (reposts * 4) + 1.0;

    const textContent = (candidate.content || '').toLowerCase();
    const hashtagSet = new Set(textContent.match(/#[a-zA-Z0-9_]+/g) || []);

    let interestScore = 0.0;
    for (const { tag, weight, regex } of context.interestPatterns) {
        if (hashtagSet.has(tag) || regex.test(textContent)) {
            interestScore += weight * INTEREST_WEIGHT;
        }
    }

    // 16.2: Boost posts that use hashtags the VIEWER themselves posts a lot
    // with — someone who tags every post #devops should see more #devops
    // content even before any offline interest-profile job has ever run.
    let authoredHashtagScore = 0.0;
    for (const { tag, weight } of context.authoredHashtagPatterns || []) {
        if (hashtagSet.has(tag)) {
            authoredHashtagScore += weight * AUTHORED_HASHTAG_WEIGHT;
        }
    }

    let searchScore = 0.0;
    for (const { regex } of context.keywordPatterns) {
        if (regex.test(textContent)) {
            searchScore += SEARCH_WEIGHT;
        }
    }

    let socialMultiplier = 1.0;
    if (candidate.authorProfileId && context.following.has(candidate.authorProfileId)) {
        socialMultiplier = FOLLOW_MULTIPLIER;
    }

    let score = (baseScore + interestScore + authoredHashtagScore + searchScore) * socialMultiplier;

    const decay = 1.0 / Math.pow(ageHours + 2.0, TIME_DECAY_GRAVITY);
    score *= decay;

    if (context.seenIds.has(candidate.post_id)) {
        score *= SEEN_PENALTY_MULTIPLIER;
    }

    const jitter = jitterForPost(seedString, candidate.post_id);
    score *= jitter;

    return score;
}

// =====================================================================
// Diversification — greedy, cooldown-aware, author-capped.
// ---------------------------------------------------------------------
// `items` is any array of { score, ...whatever } objects.
// `authorKeyFn(item)` returns whatever identity should be diversified
// against (usually user_id, or repost_user_id for reposts).
//
// Guarantees (barring the pigeonhole case where a single author IS every
// remaining candidate, which no ordering can fix):
//   1. No author appears twice within `cooldownWindow` slots of themself.
//   2. No single author contributes more than the computed per-author cap.
// The highest-scoring eligible post is always chosen first, so posts that
// score well from interest/search/follow signals still surface at the top.
// =====================================================================
export function diversifyByAuthor(items, options = {}) {
    const {
        limit = items.length,
        authorKeyFn = (item) => item.authorKey,
        minAuthorCap = DEFAULT_MIN_AUTHOR_CAP,
        maxAuthorCap = DEFAULT_MAX_AUTHOR_CAP,
        maxAuthorShare = DEFAULT_MAX_AUTHOR_SHARE,
        cooldownWindow = DEFAULT_COOLDOWN,
    } = options;

    const buckets = new Map();
    for (const item of items) {
        const key = authorKeyFn(item);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(item);
    }
    for (const bucket of buckets.values()) {
        bucket.sort((a, b) => b.score - a.score);
    }

    // Cap: however many posts an author actually has queued up, only let
    // this many of them into a single page. This is what stops a 20-post
    // burst from a single (dummy or otherwise) account from flooding the
    // feed, even in the degenerate case where they're the only author.
    const perAuthorCap = Math.min(
        maxAuthorCap,
        Math.max(minAuthorCap, Math.ceil(limit * maxAuthorShare))
    );
    for (const [key, bucket] of buckets) {
        if (bucket.length > perAuthorCap) {
            buckets.set(key, bucket.slice(0, perAuthorCap));
        }
    }

    const authorKeys = [...buckets.keys()];
    const effectiveCooldown = Math.min(cooldownWindow, Math.max(0, authorKeys.length - 1));
    const pointers = new Map(authorKeys.map(k => [k, 0]));
    const recent = [];
    const output = [];

    while (output.length < limit) {
        let eligible = authorKeys.filter(k => pointers.get(k) < buckets.get(k).length && !recent.includes(k));
        if (eligible.length === 0) {
            // Nobody eligible under cooldown — relax it. This only happens
            // when one author is the only one left with posts, i.e. the
            // pigeonhole case that's mathematically unavoidable.
            eligible = authorKeys.filter(k => pointers.get(k) < buckets.get(k).length);
            if (eligible.length === 0) break; // nothing left anywhere
        }

        let bestKey = null;
        let bestScore = -Infinity;
        for (const k of eligible) {
            const candidate = buckets.get(k)[pointers.get(k)];
            if (candidate.score > bestScore) {
                bestScore = candidate.score;
                bestKey = k;
            }
        }

        output.push(buckets.get(bestKey)[pointers.get(bestKey)]);
        pointers.set(bestKey, pointers.get(bestKey) + 1);
        recent.push(bestKey);
        if (recent.length > effectiveCooldown) recent.shift();
    }

    return output;
}

// =====================================================================
// Standalone entry point — organic top-level posts only (no reposts).
// Kept for any other caller that just wants "give me userId's ranked feed
// of post ids" without merging in a reposts union query (that merge is
// done inline in town-hall-routes.js for the home feed, since only that
// route knows about the reposts union).
// =====================================================================
export async function getPersonalizedFeed(userId, limit = 150) {
    try {
        const context = await getUserPersonalizationContext(userId);

        const posts = await prisma.town_hall_post.findMany({
            where: {
                parent_id: null,
                is_banned: false,
                OR: [
                    { scheduled_at: null },
                    { scheduled_at: { lte: new Date() } }
                ]
            },
            take: Math.min(limit * 3, 600),
            orderBy: { created_at: 'desc' },
            select: {
                post_id: true,
                user_id: true,
                content: true,
                created_at: true,
                user: { select: { social_profiles: { select: { profile_id: true } } } },
                _count: { select: { likes: true, replies: true, reposts: true } },
            }
        });

        // Score in a stable, DB-row-order-independent sequence so the seeded
        // RNG is consumed identically every time this runs on the same day,
        // not just within a single request.
        posts.sort((a, b) => a.post_id - b.post_id);

        const seedString = `${userId}:${utcDayBucket()}`;

        const scoredItems = posts.map(post => {
            const candidate = {
                post_id: post.post_id,
                content: post.content,
                created_at: post.created_at,
                likes: post._count?.likes ?? 0,
                replies: post._count?.replies ?? 0,
                reposts: post._count?.reposts ?? 0,
                authorProfileId: post.user?.social_profiles?.profile_id ?? null,
            };
            return {
                post_id: post.post_id,
                authorKey: post.user_id,
                score: scoreCandidate(candidate, context, seedString),
            };
        });

        const diversified = diversifyByAuthor(scoredItems, { limit });
        return diversified.map(p => p.post_id);
    } catch (err) {
        console.error('CRITICAL ERROR IN RECOMMENDATION ENGINE:', err.message);
        return [];
    }
}

// =====================================================================
// 17.0  Trending hashtags — x.com-style "Trending now": count hashtag
// usage across recent, visible, top-level posts and rank by raw
// frequency. Not viewer-specific (global), so it's cheap to cache with a
// short TTL at the route layer.
// =====================================================================
export async function getTrendingHashtags(limit = 10, windowHours = 48) {
    const since = new Date(Date.now() - windowHours * 3600000);
    const posts = await prisma.town_hall_post.findMany({
        where: {
            parent_id: null,
            is_banned: false,
            created_at: { gte: since },
            OR: [{ scheduled_at: null }, { scheduled_at: { lte: new Date() } }],
        },
        select: { content: true },
        take: 5000,
    });

    const counts = new Map();
    for (const post of posts) {
        for (const tag of extractHashtags(post.content)) {
            counts.set(tag, (counts.get(tag) || 0) + 1);
        }
    }

    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([tag, count]) => ({ tag, count }));
}
