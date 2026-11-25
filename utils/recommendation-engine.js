// utils/recommendation-engine.js
// ─────────────────────────────────────────────────────────────────────────────
// CONTENT RECOMMENDATION ENGINE
//
// A hybrid, explainable recommender for the social feed. It blends:
//   • content similarity  — token (hashtag/keyword/niche) overlap between a
//                           candidate and the user's learned interest vector
//   • engagement quality  — a time-decayed hot score (likes/comments/saves)
//   • trending            — boost for tokens that are globally hot right now
//   • recency             — fresh content surfaces faster
//   • creator affinity    — a nudge toward creators the user engages with
// then re-ranks for DIVERSITY (so one topic/creator can't dominate) and injects
// a slice of SERENDIPITY candidates (related-but-exploratory) so the feed never
// collapses into a filter bubble.
//
// The similarity step is deliberately isolated behind `computeSimilarity()` so a
// future semantic backend (embeddings + pgvector) can be swapped in without
// touching candidate generation, scoring, or re-ranking.
// ─────────────────────────────────────────────────────────────────────────────

import prisma from './prisma-client.js';
import { visibleVideoWhere } from './video-visibility.js';

// Note: visibleVideoWhere is imported for getVideoUpNext; getForYou still uses its own
// inline predicate + hls_url guard for inline playback on the social For-You rail.

// ─── Tunables ────────────────────────────────────────────────────────────────

// Relative value of each engagement signal when LEARNING a user's interests.
export const SIGNAL_WEIGHTS = {
  save:    5.0, // strongest explicit intent
  share:   5.0,
  comment: 4.0,
  follow:  4.0, // creator-level affinity
  like:    3.0,
  vlike:   3.0, // video like
  vsave:   5.0, // video "watch later"
  watch:   2.5, // video watch-history (scaled by progress)
  vsearch: 2.0, // video search queries (intent; includes zero-result demand)
  view:    1.0, // passive post view
  dwell:   0.10, // per second of dwell time, capped (see DWELL_CAP_SEC)
};
const DWELL_CAP_SEC = 30;

// How candidate scores are combined when RANKING.
const RANK_WEIGHTS = {
  similarity: 0.42,
  engagement: 0.20,
  trending:   0.14,
  recency:    0.14,
  creator:    0.10,
};

const INTEREST_HALF_LIFE_DAYS = 21; // engagement older than this counts for half
const CANDIDATE_WINDOW_DAYS    = 45; // only recommend reasonably fresh content
const SERENDIPITY_RATIO        = 0.15; // ~1 in 7 slots reserved for exploration
const MAX_TOKENS_PER_ITEM      = 24;
const TOP_TOKENS_KEEP          = 40;
const TOP_CREATORS_KEEP        = 30;

// ─── Tokenisation (content feature extraction) ───────────────────────────────

const STOPWORDS = new Set([
  'the','and','for','are','but','not','you','your','with','this','that','have',
  'from','they','will','what','when','where','which','who','was','were','has',
  'had','can','could','would','should','about','into','than','then','them','their',
  'there','here','been','being','just','like','some','more','most','very','also',
  'over','only','its','our','out','off','all','any','get','got','one','two','new',
  'now','how','why','who','via','per','etc','too','his','her','him','she','its',
  'because','while','after','before','again','still','such','each','other','these',
  'those','does','done','doing','make','made','want','need','really','today',
]);

/**
 * Turn free text (+ optional extra tags like a channel niche) into a bounded,
 * deduped set of normalised feature tokens. Hashtags are preserved with their
 * leading `#`; bare keywords are lowercased and stop-word filtered.
 */
export function extractTokens(text, extra = []) {
  const tokens = new Set();

  if (text && typeof text === 'string') {
    const lower = text.toLowerCase();
    for (const tag of lower.match(/#[a-z0-9_]+/g) || []) {
      if (tag.length >= 2 && tag.length <= 80) tokens.add(tag);
    }
    const body = lower.replace(/#[a-z0-9_]+/g, ' ');
    for (const w of body.match(/[a-z][a-z0-9]{3,}/g) || []) {
      if (w.length <= 40 && !STOPWORDS.has(w)) tokens.add(w);
    }
  }

  for (const e of extra) {
    if (!e) continue;
    for (const w of String(e).toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || []) {
      if (!STOPWORDS.has(w)) tokens.add(w);
    }
    if (tokens.size >= MAX_TOKENS_PER_ITEM * 2) break;
  }

  return Array.from(tokens).slice(0, MAX_TOKENS_PER_ITEM);
}

const postTokens  = (p) => extractTokens(p?.caption_text);
const videoTokens = (v) =>
  extractTokens(`${v?.title ?? ''} ${v?.description ?? ''}`, [v?.channel?.content_niche, v?.video_type]);

// ─── Similarity (SWAPPABLE INTERFACE) ────────────────────────────────────────

/**
 * Similarity between a learned interest vector and a content item's tokens.
 * Sparse dot-product, length-normalised so token-spammy items aren't unfairly
 * boosted. Replace the body with an embedding cosine to upgrade to semantic
 * similarity — nothing else in this module needs to change.
 */
export function computeSimilarity(interests, tokens) {
  if (!tokens.length) return 0;
  let dot = 0;
  for (const tk of tokens) dot += interests[tk] || 0;
  return dot / Math.sqrt(tokens.length);
}

// ─── Hot score (engagement quality + freshness) ──────────────────────────────

function hotScore({ likes = 0, comments = 0, saves = 0, createdAt }) {
  const engagement = likes * 3 + comments * 5 + saves * 2;
  const ageHours = (Date.now() - new Date(createdAt).getTime()) / 3.6e6;
  return engagement / Math.pow(ageHours + 2, 1.5);
}

function recencyScore(createdAt) {
  const ageHours = Math.max(0, (Date.now() - new Date(createdAt).getTime()) / 3.6e6);
  return Math.exp(-ageHours / (CANDIDATE_WINDOW_DAYS * 24 * 0.5)); // ~half-life mid-window
}

const decayFactor = (date) => {
  if (!date) return 0.6; // signals with no timestamp (e.g. likes) → moderate weight
  const ageDays = (Date.now() - new Date(date).getTime()) / 8.64e7;
  return Math.pow(0.5, Math.max(0, ageDays) / INTEREST_HALF_LIFE_DAYS);
};

// ─── Interest profile construction (the "learning" step) ─────────────────────

/**
 * Aggregate a profile's recent engagement into a weighted interest vector.
 * Returns { interests:{token:weight}, topTokens:[], topCreators:[], signalCount }.
 * Reads existing engagement tables, content_impression dwell, video watch history,
 * and video_search_history so /video/home-feed can rank from watches + searches.
 */
export async function buildInterestProfile(profileId, userId = null) {
  const interests = {};      // token -> weight
  const creators  = {};      // post author profile_id -> weight
  let signalCount = 0;

  const addContent = (tokens, weight, authorId) => {
    if (!(weight > 0) || !tokens.length) return;
    for (const tk of tokens) interests[tk] = (interests[tk] || 0) + weight;
    if (authorId != null) creators[authorId] = (creators[authorId] || 0) + weight;
    signalCount += 1;
  };

  // Resolve user_id (needed for video-side signals) if not supplied.
  if (userId == null) {
    const prof = await prisma.social_profile
      .findUnique({ where: { profile_id: profileId }, select: { user_id: true } })
      .catch(() => null);
    userId = prof?.user_id ?? null;
  }

  const selPost = { caption_text: true, profile_id: true };

  const [saves, likes, shares, comments, views, dwell, follows] = await Promise.all([
    prisma.social_bookmark.findMany({
      where: { profile_id: profileId }, take: 200, orderBy: { created_at: 'desc' },
      select: { created_at: true, social_post: { select: selPost } },
    }).catch(() => []),
    prisma.social_interactions.findMany({
      where: { profile_id: profileId, reaction_type: 'like' }, take: 300,
      select: { social_feed: { select: selPost } },
    }).catch(() => []),
    prisma.social_interactions.findMany({
      where: { profile_id: profileId, reaction_type: 'share' }, take: 200,
      select: { social_feed: { select: selPost } },
    }).catch(() => []),
    prisma.social_comments.findMany({
      where: { profile_id: profileId }, take: 200, orderBy: { timestamp: 'desc' },
      select: { timestamp: true, social_feed: { select: selPost } },
    }).catch(() => []),
    prisma.social_post_view.findMany({
      where: { profile_id: profileId }, take: 300, orderBy: { created_at: 'desc' },
      select: { created_at: true, social_post: { select: selPost } },
    }).catch(() => []),
    prisma.content_impression.findMany({
      where: { profile_id: profileId, content_type: 'post', dwell_ms: { gt: 1500 } },
      take: 300, orderBy: { updated_at: 'desc' },
      select: { content_id: true, dwell_ms: true, completed: true },
    }).catch(() => []),
    prisma.follower.findMany({
      where: { follower_id: profileId }, take: 500, select: { following_id: true },
    }).catch(() => []),
  ]);

  for (const s of saves)    addContent(postTokens(s.social_post),  SIGNAL_WEIGHTS.save    * decayFactor(s.created_at), s.social_post?.profile_id);
  for (const l of likes)    addContent(postTokens(l.social_feed),  SIGNAL_WEIGHTS.like    * decayFactor(null),        l.social_feed?.profile_id);
  for (const s of shares)   addContent(postTokens(s.social_feed),  SIGNAL_WEIGHTS.share   * decayFactor(null),        s.social_feed?.profile_id);
  for (const c of comments) addContent(postTokens(c.social_feed),  SIGNAL_WEIGHTS.comment * decayFactor(c.timestamp), c.social_feed?.profile_id);
  for (const v of views)    addContent(postTokens(v.social_post),  SIGNAL_WEIGHTS.view    * decayFactor(v.created_at), v.social_post?.profile_id);

  // Dwell time → needs captions for the impressed posts (no relation on the table).
  if (dwell.length) {
    const ids = dwell.map(d => d.content_id);
    const posts = await prisma.social_feed.findMany({
      where: { social_post_id: { in: ids } },
      select: { social_post_id: true, caption_text: true, profile_id: true },
    }).catch(() => []);
    const byId = new Map(posts.map(p => [p.social_post_id, p]));
    for (const d of dwell) {
      const p = byId.get(d.content_id);
      if (!p) continue;
      const sec = Math.min(d.dwell_ms / 1000, DWELL_CAP_SEC);
      const w = SIGNAL_WEIGHTS.dwell * sec * (d.completed ? 1.4 : 1);
      addContent(postTokens(p), w, p.profile_id);
    }
  }

  // Follows: strong creator-level affinity (no content tokens of their own).
  for (const f of follows) creators[f.following_id] = (creators[f.following_id] || 0) + SIGNAL_WEIGHTS.follow;

  // ─── Video-side signals (unified recommender) ──────────────────────────────
  if (userId != null) {
    const selVid = {
      video: { select: { title: true, description: true, video_type: true, channel: { select: { content_niche: true } } } },
    };
    const [vlikes, vsaves, history, searches] = await Promise.all([
      prisma.video_likes.findMany({ where: { user_id: userId, is_like: true }, take: 200, select: selVid }).catch(() => []),
      prisma.video_watch_later.findMany({ where: { user_id: userId }, take: 200, orderBy: { saved_at: 'desc' }, select: { saved_at: true, ...selVid } }).catch(() => []),
      prisma.watch_history.findMany({ where: { user_id: userId }, take: 200, orderBy: { watched_at: 'desc' },
        select: { watched_at: true, last_position: true, video: { select: { title: true, description: true, video_type: true, duration_sec: true, channel: { select: { content_niche: true } } } } } }).catch(() => []),
      // Recent searches — intent the user typed, including zero-result demand that watch history never sees.
      prisma.video_search_history.findMany({
        where: { user_id: userId },
        take: 100,
        orderBy: { created_at: 'desc' },
        select: { query: true, result_count: true, created_at: true },
      }).catch(() => []),
    ]);

    for (const l of vlikes) addContent(videoTokens(l.video), SIGNAL_WEIGHTS.vlike * decayFactor(null), null);
    for (const s of vsaves) addContent(videoTokens(s.video), SIGNAL_WEIGHTS.vsave * decayFactor(s.saved_at), null);
    for (const h of history) {
      const dur = h.video?.duration_sec || 0;
      const progress = dur > 0 ? Math.min(1, (h.last_position || 0) / dur) : 0.4;
      addContent(videoTokens(h.video), SIGNAL_WEIGHTS.watch * (0.4 + progress) * decayFactor(h.watched_at), null);
    }
    // Most-recent-first from Prisma; keep one row per normalised query so spam repeats
    // cannot flood signalCount / bury watch signals.
    const seenQueries = new Set();
    for (const s of searches) {
      const q = typeof s.query === 'string' ? s.query.trim() : '';
      if (!q) continue;
      const key = q.toLowerCase();
      if (seenQueries.has(key)) continue;
      seenQueries.add(key);
      const tokens = extractTokens(q);
      if (!tokens.length) continue;
      // Zero-result searches are demand that watch history never sees — slight boost.
      const emptyBoost = s.result_count === 0 ? 1.25 : 1;
      addContent(tokens, SIGNAL_WEIGHTS.vsearch * emptyBoost * decayFactor(s.created_at), null);
    }
  }

  const topTokens = Object.entries(interests).sort((a, b) => b[1] - a[1]).slice(0, TOP_TOKENS_KEEP).map(([t]) => t);
  const topCreators = Object.entries(creators).sort((a, b) => b[1] - a[1]).slice(0, TOP_CREATORS_KEEP).map(([id]) => Number(id));

  return { interests, topTokens, topCreators, signalCount };
}

/** Build + persist a profile's interest vector. */
export async function refreshInterestProfile(profileId, userId = null) {
  const { interests, topTokens, topCreators, signalCount } = await buildInterestProfile(profileId, userId);
  const data = { interests, top_tokens: topTokens, top_creators: topCreators, signal_count: signalCount, computed_at: new Date() };
  await prisma.user_interest_profile.upsert({
    where: { profile_id: profileId },
    update: data,
    create: { profile_id: profileId, ...data },
  });
  return { topTokens, signalCount };
}

/**
 * Refresh interest profiles for users who have engaged recently (called by cron).
 * Keeps recommendations "continuously learning" without recomputing everyone.
 */
export async function refreshActiveInterestProfiles({ sinceMinutes = 30, limit = 400 } = {}) {
  const since = new Date(Date.now() - sinceMinutes * 60000);
  const [imps, books, comms, searches] = await Promise.all([
    prisma.content_impression.findMany({ where: { updated_at: { gte: since } }, select: { profile_id: true }, take: 5000 }).catch(() => []),
    prisma.social_bookmark.findMany({ where: { created_at: { gte: since } }, select: { profile_id: true }, take: 2000 }).catch(() => []),
    prisma.social_comments.findMany({ where: { timestamp: { gte: since } }, select: { profile_id: true }, take: 2000 }).catch(() => []),
    // Search-only viewers never hit the tables above — still need interest refresh for home-feed.
    prisma.video_search_history.findMany({ where: { created_at: { gte: since } }, select: { user_id: true }, take: 2000 }).catch(() => []),
  ]);
  const profileIds = [...imps, ...books, ...comms].map((r) => r.profile_id).filter(Boolean);
  const searchUserIds = [...new Set(searches.map((r) => r.user_id).filter(Boolean))];
  if (searchUserIds.length) {
    const profiles = await prisma.social_profile.findMany({
      where: { user_id: { in: searchUserIds } },
      select: { profile_id: true },
    }).catch(() => []);
    for (const p of profiles) {
      if (p.profile_id != null) profileIds.push(p.profile_id);
    }
  }
  const ids = [...new Set(profileIds)].slice(0, limit);
  let ok = 0;
  for (const pid of ids) {
    try { await refreshInterestProfile(pid); ok += 1; } catch { /* skip one bad profile */ }
  }
  return { refreshed: ok, candidates: ids.length };
}

/**
 * Recompute the rolling set of trending tokens from recent posts, weighted by
 * engagement and freshness. Stored in trending_topic for fast lookup at rank time.
 */
export async function refreshTrendingTopics({ windowDays = 3, keep = 200 } = {}) {
  const since = new Date(Date.now() - windowDays * 86400000);
  const posts = await prisma.social_feed.findMany({
    where: { status: 'published', created_at: { gte: since } },
    take: 1500, orderBy: { created_at: 'desc' },
    select: { caption_text: true, created_at: true,
      _count: { select: { social_interactions: true, social_comments: true, bookmarks: true } } },
  }).catch(() => []);

  const scores = {};
  for (const p of posts) {
    const eng = 1 + (p._count?.social_interactions || 0) + (p._count?.social_comments || 0) * 1.5 + (p._count?.bookmarks || 0);
    const w = eng * recencyScore(p.created_at);
    for (const tk of postTokens(p)) scores[tk] = (scores[tk] || 0) + w;
  }

  const top = Object.entries(scores).sort((a, b) => b[1] - a[1]).slice(0, keep);
  for (const [token, score] of top) {
    await prisma.trending_topic.upsert({
      where: { token: token.slice(0, 80) },
      update: { score, window_days: windowDays, computed_at: new Date() },
      create: { token: token.slice(0, 80), score, window_days: windowDays },
    }).catch(() => {});
  }
  return { tokens: top.length };
}

async function loadTrendingMap() {
  const rows = await prisma.trending_topic.findMany({ select: { token: true, score: true } }).catch(() => []);
  const map = {};
  let max = 0;
  for (const r of rows) { map[r.token] = r.score; if (r.score > max) max = r.score; }
  return { map, max: max || 1 };
}

// ─── Candidate scoring + re-ranking ──────────────────────────────────────────

function scoreCandidates(candidates, { interests, topCreators, trending }) {
  const creatorSet = new Set(topCreators);
  const raw = candidates.map(c => {
    const similarity = computeSimilarity(interests, c.tokens);
    const engagement = hotScore(c.metrics);
    const recency = recencyScore(c.createdAt);
    let trend = 0;
    for (const tk of c.tokens) trend += trending.map[tk] || 0;
    trend = trend / (trending.max * Math.sqrt(c.tokens.length || 1));
    const creator = c.authorId != null && creatorSet.has(c.authorId) ? 1 : 0;
    return { c, similarity, engagement, recency, trend, creator };
  });

  // Normalise each component to ~[0,1] across the candidate set.
  const maxOf = (k) => raw.reduce((m, r) => Math.max(m, r[k]), 0) || 1;
  const mSim = maxOf('similarity'), mEng = maxOf('engagement');

  for (const r of raw) {
    const simN = r.similarity / mSim;
    r.c._components = {
      similarity: simN,
      engagement: r.engagement / mEng,
      trending: Math.min(1, r.trend),
      recency: r.recency,
      creator: r.creator,
    };
    r.c._isExploration = simN < 0.12; // weak personal match → exploration pool
    r.c._score =
      RANK_WEIGHTS.similarity * r.c._components.similarity +
      RANK_WEIGHTS.engagement * r.c._components.engagement +
      RANK_WEIGHTS.trending   * r.c._components.trending +
      RANK_WEIGHTS.recency    * r.c._components.recency +
      RANK_WEIGHTS.creator    * r.c._components.creator;
    r.c._reason = pickReason(r.c._components, r.c);
  }
  return candidates;
}

function pickReason(comp, c) {
  if (comp.creator) return 'From a creator you engage with';
  if (comp.similarity >= 0.5) return `Because you like ${c.topToken ? c.topToken.replace('#', '#') : 'similar content'}`;
  if (comp.trending >= 0.5) return 'Trending in your interests';
  if (c._isExploration) return 'Something new for you';
  return 'Popular right now';
}

/**
 * Greedy diversity re-rank (MMR-style): repeatedly take the best-scoring
 * candidate, then damp anything that shares its tokens or creator so a single
 * topic/creator cannot dominate the result list.
 */
function diversityRerank(candidates, limit) {
  const picked = [];
  const tokenUse = {};
  const creatorUse = {};
  const pool = [...candidates];

  while (picked.length < limit && pool.length) {
    let bestIdx = 0, bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];
      let penalty = 0;
      for (const tk of c.tokens) penalty += (tokenUse[tk] || 0);
      penalty += (c.authorId != null ? (creatorUse[c.authorId] || 0) * 2 : 0);
      const adjusted = c._score - 0.06 * penalty;
      if (adjusted > bestVal) { bestVal = adjusted; bestIdx = i; }
    }
    const [chosen] = pool.splice(bestIdx, 1);
    picked.push(chosen);
    for (const tk of chosen.tokens) tokenUse[tk] = (tokenUse[tk] || 0) + 1;
    if (chosen.authorId != null) creatorUse[chosen.authorId] = (creatorUse[chosen.authorId] || 0) + 1;
  }
  return picked;
}

/**
 * Interleave exploration ("serendipity") candidates into the ranked list at a
 * fixed cadence so the feed stays relevant but never becomes a filter bubble.
 */
function injectSerendipity(ranked, exploration, limit) {
  if (!exploration.length) return ranked.slice(0, limit);
  const everyN = Math.max(2, Math.round(1 / SERENDIPITY_RATIO));
  const out = [];
  let ei = 0, ri = 0;
  const usedKey = new Set(ranked.map(keyOf));
  while (out.length < limit && (ri < ranked.length || ei < exploration.length)) {
    const slot = out.length + 1;
    if (slot % everyN === 0 && ei < exploration.length) {
      let cand = exploration[ei++];
      while (cand && usedKey.has(keyOf(cand)) && ei < exploration.length) cand = exploration[ei++];
      if (cand && !usedKey.has(keyOf(cand))) { out.push(cand); usedKey.add(keyOf(cand)); continue; }
    }
    if (ri < ranked.length) out.push(ranked[ri++]);
    else if (ei < exploration.length) out.push(exploration[ei++]);
    else break;
  }
  return out.slice(0, limit);
}

const keyOf = (c) => `${c.content_type}:${c.id}`;

// ─── Candidate generation helpers ────────────────────────────────────────────

const POST_INCLUDE = (myProfileId) => ({
  social_profile: { select: { handle: true, display_name: true, profile_pic_url: true, is_verified: true, user_id: true } },
  social_media_attachments: { orderBy: { sequence_order: 'asc' } },
  bookmarks: { where: { profile_id: myProfileId } },
  social_interactions: { where: { profile_id: myProfileId, reaction_type: 'like' } },
  _count: { select: { social_comments: true, social_interactions: true, bookmarks: true } },
});

function tokenContainsOR(tokens, field) {
  return tokens.slice(0, 25).map(t => ({ [field]: { contains: t.replace(/^#/, ''), mode: 'insensitive' } }));
}

function wrapPost(p) {
  const tokens = postTokens(p);
  return {
    content_type: 'post',
    id: p.social_post_id,
    tokens,
    topToken: tokens[0] ?? null,
    authorId: p.profile_id ?? p.social_profile?.profile_id ?? null,
    createdAt: p.created_at,
    metrics: {
      likes: p._count?.social_interactions ?? 0,
      comments: p._count?.social_comments ?? 0,
      saves: p._count?.bookmarks ?? 0,
      createdAt: p.created_at,
    },
    payload: {
      ...p,
      id: p.social_post_id,
      mediaUrl: p.social_media_attachments?.[0]?.media_url ?? null,
      media_url: p.social_media_attachments?.[0]?.media_url ?? null,
      is_ad: false,
      liked: (p.social_interactions?.length ?? 0) > 0,
      saved: (p.bookmarks?.length ?? 0) > 0,
    },
  };
}

function wrapVideo(v) {
  const tokens = videoTokens(v);
  return {
    content_type: 'video',
    id: v.video_id,
    tokens,
    topToken: tokens[0] ?? null,
    authorId: null,
    createdAt: v.created_at,
    metrics: { likes: v._count?.video_likes ?? 0, comments: v._count?.video_comments ?? 0, saves: 0, createdAt: v.created_at },
    payload: {
      content_type: 'video',
      id: v.video_id,
      video_id: v.video_id,
      title: v.title,
      description: v.description,
      videoUrl: v.hls_url || v.raw_video_url || '',
      hls_url: v.hls_url,
      thumbnail_url: v.thumbnail_url,
      duration_sec: v.duration_sec,
      views_count: v.views_count,
      user: v.channel?.display_name ?? 'Creator',
      handle: v.channel?.handle ? `@${v.channel.handle}` : '@creator',
      avatarUrl: v.channel?.profile_pic_url ?? null,
      channel: v.channel,
    },
  };
}

// ─── Public: personalised "For You" feed ─────────────────────────────────────

/**
 * Generate a ranked, diversified, serendipity-aware recommendation list mixing
 * posts and (optionally) videos from creators the user does NOT already follow.
 *
 * @returns {Promise<{ items: object[], nextCursor: number|null, cold: boolean }>}
 */
export async function getForYou({ profileId, userId = null, limit = 12, offset = 0, includeVideos = true }) {
  // 1) Interest vector (use stored profile; fall back to a live build).
  let interests = {}, topTokens = [], topCreators = [], signalCount = 0;
  const stored = profileId
    ? await prisma.user_interest_profile.findUnique({ where: { profile_id: profileId } }).catch(() => null)
    : null;
  if (stored) {
    interests = stored.interests || {};
    topTokens = stored.top_tokens || [];
    topCreators = stored.top_creators || [];
    signalCount = stored.signal_count || 0;
  } else if (profileId) {
    const built = await buildInterestProfile(profileId, userId);
    ({ interests, topTokens, topCreators, signalCount } = built);
  }
  const cold = signalCount < 3 || topTokens.length === 0;

  // 2) Exclusions: own + followed authors, already seen / watched content.
  const [following, seen, impressedPosts, impressedVideos, watched, subs, me] = await Promise.all([
    profileId ? prisma.follower.findMany({ where: { follower_id: profileId }, select: { following_id: true } }).catch(() => []) : [],
    profileId ? prisma.social_seen_post.findMany({ where: { profile_id: profileId }, select: { post_id: true }, take: 1000, orderBy: { seen_at: 'desc' } }).catch(() => []) : [],
    profileId ? prisma.content_impression.findMany({ where: { profile_id: profileId, content_type: 'post' }, select: { content_id: true }, take: 1500 }).catch(() => []) : [],
    profileId ? prisma.content_impression.findMany({ where: { profile_id: profileId, content_type: 'video' }, select: { content_id: true }, take: 1000 }).catch(() => []) : [],
    userId ? prisma.watch_history.findMany({ where: { user_id: userId }, select: { video_id: true }, take: 500 }).catch(() => []) : [],
    userId ? prisma.subscription.findMany({ where: { user_id: userId }, select: { channel_id: true } }).catch(() => []) : [],
    profileId ? prisma.social_profile.findUnique({ where: { profile_id: profileId }, select: { user_id: true } }).catch(() => null) : null,
  ]);
  if (userId == null) userId = me?.user_id ?? null;

  const followingIds = following.map(f => f.following_id);
  const excludeAuthors = [...followingIds, ...(profileId ? [profileId] : [])];
  const excludePostIds = [...new Set([...seen.map(s => s.post_id), ...impressedPosts.map(i => i.content_id)])];
  const excludeVideoIds = [...new Set([...impressedVideos.map(i => i.content_id), ...watched.map(w => w.video_id)])];
  const subChannelIds = subs.map(s => s.channel_id);
  const windowStart = new Date(Date.now() - CANDIDATE_WINDOW_DAYS * 86400000);
  const trending = await loadTrendingMap();

  // 3) Candidate generation — personalised pool + a quality/trending pool.
  const postWhereBase = {
    status: 'published',
    created_at: { gte: windowStart },
    ...(excludeAuthors.length ? { profile_id: { notIn: excludeAuthors } } : {}),
    ...(excludePostIds.length ? { social_post_id: { notIn: excludePostIds } } : {}),
  };

  const [matchedPosts, qualityPosts] = await Promise.all([
    (!cold)
      ? prisma.social_feed.findMany({
          where: { ...postWhereBase, OR: tokenContainsOR(topTokens, 'caption_text') },
          include: POST_INCLUDE(profileId), take: 140, orderBy: { created_at: 'desc' },
        }).catch(() => [])
      : Promise.resolve([]),
    prisma.social_feed.findMany({
      where: postWhereBase, include: POST_INCLUDE(profileId),
      take: cold ? 120 : 50, orderBy: { social_interactions: { _count: 'desc' } },
    }).catch(() => []),
  ]);

  let matchedVideos = [], qualityVideos = [];
  if (includeVideos) {
    // Was: `{ status:'safe', hls_url:{ not:null } }` with no processing_status / is_active /
    // not-banned guard — i.e. a DIFFERENT visibility rule than /feed and /search, so a video could be
    // in one rail and not the other. Use the shared predicate. hls_url is kept as an extra AND: the
    // For-You rail plays inline, so a done-but-null-hls_url row (legacy; see the fallback at
    // /video/play) would render an unplayable card here.
    const vidWhereBase = visibleVideoWhere({
      hls_url: { not: null },
      created_at: { gte: windowStart },
      ...(excludeVideoIds.length ? { video_id: { notIn: excludeVideoIds } } : {}),
      ...(subChannelIds.length ? { channel_id: { notIn: subChannelIds } } : {}),
    });
    const VID_INCLUDE = {
      channel: { select: { channel_id: true, handle: true, display_name: true, content_niche: true, profile_pic_url: true } }, 
      _count: { select: { video_likes: true, video_comments: true } } 
    };
    [matchedVideos, qualityVideos] = await Promise.all([
      (!cold)
        ? prisma.video.findMany({
            where: { ...vidWhereBase, OR: [...tokenContainsOR(topTokens, 'title'), ...tokenContainsOR(topTokens, 'description')] },
            include: VID_INCLUDE, take: 80, orderBy: { created_at: 'desc' },
          }).catch(() => [])
        : Promise.resolve([]),
      prisma.video.findMany({ where: vidWhereBase, include: VID_INCLUDE, take: cold ? 60 : 25, orderBy: { views_count: 'desc' } }).catch(() => []),
    ]);
  }

  // 4) De-dupe candidates by key, wrap into the scoring shape.
  const wrapped = new Map();
  for (const p of [...matchedPosts, ...qualityPosts]) {
    const w = wrapPost(p);
    if (w.tokens.length || cold) wrapped.set(keyOf(w), w);
  }
  for (const v of [...matchedVideos, ...qualityVideos]) {
    const w = wrapVideo(v);
    wrapped.set(keyOf(w), w);
  }
  let candidates = [...wrapped.values()];
  if (!candidates.length) return { items: [], nextCursor: null, cold };

  // 5) Score, split exploration vs core, diversify, weave in serendipity.
  scoreCandidates(candidates, { interests, topCreators, trending });
  candidates.sort((a, b) => b._score - a._score);

  const core = candidates.filter(c => !c._isExploration);
  const exploration = candidates.filter(c => c._isExploration)
    .sort((a, b) => (b._components.engagement + b._components.trending) - (a._components.engagement + a._components.trending));

  const pageEnd = offset + limit;
  const need = pageEnd + limit; // re-rank a bit beyond the page for stable diversity
  const rankedCore = diversityRerank(cold ? candidates : core, Math.min(need, (cold ? candidates : core).length));
  const woven = cold ? rankedCore : injectSerendipity(rankedCore, exploration, need);

  const pageItems = woven.slice(offset, pageEnd).map(c => ({
    ...c.payload,
    content_type: c.content_type,
    is_recommended: true,
    rec_reason: c._reason,
    _recScore: Number(c._score.toFixed(4)),
  }));

  const nextCursor = woven.length > pageEnd ? pageEnd : null;
  return { items: pageItems, nextCursor, cold };
}

/**
 * A small set of recommended NON-followed posts for blending into the chrono/
 * hot home feed. Lightweight (posts only, no video, no serendipity weaving).
 */
export async function getBlendRecommendations({ profileId, userId = null, count = 3 }) {
  if (!profileId) return [];
  try {
    const { items } = await getForYou({ profileId, userId, limit: count, offset: 0, includeVideos: false });
    return items;
  } catch {
    return [];
  }
}

// ─── Watch-page "Up Next" (related-first, then fill) ─────────────────────────
// YouTube-style Up Next: related to the open video always leads the rail.
// When related is thin/empty, popular + light randomness fills the rest.

const UP_NEXT_RANK_WEIGHTS = {
  context: 0.55,     // same channel / category / title overlap — dominates rank
  similarity: 0.12,  // learned interest vector (secondary)
  engagement: 0.12,
  trending: 0.08,
  recency: 0.08,
  personal: 0.05,    // channels/categories the viewer already watches
};
/** Minimum context score to count as "related" (title overlap floor ≈ 0.35). */
export const UP_NEXT_RELATED_MIN = 0.35;
const UP_NEXT_CANDIDATE_CAP = 140;
const UP_NEXT_BACKFILL_CAP = 60;

/** Deterministic jitter in [0,1) — stable per (seedVideo, candidate) for cacheability. */
export function seededJitter(seed, id) {
  let h = ((seed >>> 0) * 2654435761 + (id >>> 0) * 40503) >>> 0;
  h = (((h ^ (h >>> 15)) >>> 0) * 2246822519) >>> 0;
  h = (((h ^ (h >>> 13)) >>> 0) * 3266489917) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** Card fields only — never ship playback URLs / raw blobs / full Prisma rows. */
const UP_NEXT_CARD_SELECT = {
  video_id: true,
  public_id: true,
  slug: true,
  title: true,
  description: true, // scoring tokens only; stripped in toUpNextCard()
  thumbnail_url: true,
  duration_sec: true,
  views_count: true,
  video_type: true,
  category: true,
  created_at: true,
  channel_id: true,
  channel: {
    select: {
      channel_id: true,
      display_name: true,
      handle: true,
      profile_pic_url: true,
      content_niche: true,
    },
  },
  _count: { select: { video_likes: true, video_comments: true } },
};

function toUpNextCard(v) {
  return {
    video_id: v.video_id,
    public_id: v.public_id,
    slug: v.slug,
    title: v.title,
    thumbnail_url: v.thumbnail_url,
    duration_sec: v.duration_sec,
    views_count: v.views_count,
    video_type: v.video_type,
    category: v.category,
    created_at: v.created_at,
    channel_id: v.channel_id,
    channel: v.channel
      ? {
          channel_id: v.channel.channel_id,
          display_name: v.channel.display_name,
          handle: v.channel.handle,
          profile_pic_url: v.channel.profile_pic_url,
        }
      : null,
  };
}

function wrapUpNextCandidate(v) {
  const tokens = videoTokens(v);
  return {
    content_type: 'video',
    id: v.video_id,
    channelId: v.channel_id ?? null,
    category: v.category ?? 'General',
    tokens,
    topToken: tokens[0] ?? null,
    authorId: v.channel_id ?? null,
    createdAt: v.created_at,
    metrics: {
      likes: v._count?.video_likes ?? 0,
      comments: v._count?.video_comments ?? 0,
      saves: 0,
      createdAt: v.created_at,
    },
    payload: toUpNextCard(v),
  };
}

function pickUpNextReason(comp, c, seedCategory) {
  if (comp.context >= 0.85) return 'More from this channel';
  if (comp.context >= 0.55) return 'Related to what you\'re watching';
  if (comp.personal >= 0.45) return `Because you watch ${c.category || seedCategory || 'similar videos'}`;
  if (comp.similarity >= 0.5) return `Because you like ${c.topToken ? c.topToken.replace('#', '#') : 'similar content'}`;
  if (comp.trending >= 0.5) return 'Trending now';
  if (c._isExploration) return 'Something new for you';
  return `Popular in ${c.category || seedCategory || 'General'}`;
}

/**
 * Score Up Next candidates: blends context (open video), personal interests, engagement,
 * trending, recency, and watch-history affinity. Exported for unit tests.
 */
export function scoreUpNextCandidates(candidates, {
  interests,
  trending,
  currentVideo,
  currentTokens,
  watchedChannels = new Set(),
  watchedCategories = new Set(),
  seedVideoId = 0,
}) {
  const seedCategory = currentVideo?.category || 'General';
  const raw = candidates.map(c => {
    const similarity = computeSimilarity(interests, c.tokens);
    const engagement = hotScore(c.metrics);
    const recency = recencyScore(c.createdAt);
    let trend = 0;
    for (const tk of c.tokens) trend += trending.map[tk] || 0;
    trend = trend / (trending.max * Math.sqrt(c.tokens.length || 1));

    let context = 0;
    if (currentVideo?.channel_id != null && c.channelId === currentVideo.channel_id) context = 1;
    else if (c.category === seedCategory) context = 0.65;
    const overlap = currentTokens.length
      ? c.tokens.filter(t => currentTokens.includes(t)).length / currentTokens.length
      : 0;
    if (overlap > 0) context = Math.max(context, 0.35 + overlap * 0.45);

    let personal = 0;
    if (watchedChannels.has(c.channelId)) personal += 0.55;
    if (watchedCategories.has(c.category)) personal += 0.45;

    return { c, similarity, engagement, recency, trend, context, personal };
  });

  const maxOf = (k) => raw.reduce((m, r) => Math.max(m, r[k]), 0) || 1;
  const mSim = maxOf('similarity');
  const mEng = maxOf('engagement');

  for (const r of raw) {
    const simN = r.similarity / mSim;
    const related = r.context >= UP_NEXT_RELATED_MIN;
    r.c._components = {
      context: r.context,
      similarity: simN,
      engagement: r.engagement / mEng,
      trending: Math.min(1, r.trend),
      recency: r.recency,
      personal: Math.min(1, r.personal),
    };
    r.c._isRelated = related;
    // Unrelated fill gets more jitter so the tail feels varied (not the same popular list).
    const jitter = seededJitter(seedVideoId, r.c.id) * (related ? 0.04 : 0.10);
    r.c._score =
      UP_NEXT_RANK_WEIGHTS.context * r.c._components.context +
      UP_NEXT_RANK_WEIGHTS.similarity * r.c._components.similarity +
      UP_NEXT_RANK_WEIGHTS.engagement * r.c._components.engagement +
      UP_NEXT_RANK_WEIGHTS.trending * r.c._components.trending +
      UP_NEXT_RANK_WEIGHTS.recency * r.c._components.recency +
      UP_NEXT_RANK_WEIGHTS.personal * r.c._components.personal +
      jitter;
    if (!related) {
      r.c._reason = 'Suggested for you';
    } else {
      r.c._reason = pickUpNextReason(r.c._components, r.c, seedCategory);
    }
  }
  return candidates;
}

/**
 * Related (same channel / category / title overlap) always before fill/random.
 * Within each bucket, higher score wins.
 */
export function orderUpNextRelatedFirst(candidates) {
  const related = [];
  const fill = [];
  for (const c of candidates) {
    if (c._isRelated) related.push(c);
    else fill.push(c);
  }
  related.sort((a, b) => b._score - a._score);
  fill.sort((a, b) => b._score - a._score);
  return [...related, ...fill];
}

/**
 * Up Next: related to the open video first, then popular/random fill.
 * Never returns an empty first page when the catalogue has other long-form videos.
 *
 * @returns {Promise<{ items: object[], hasMore: boolean, cold: boolean }>}
 */
export async function getVideoUpNext({
  videoId,
  profileId = null,
  userId = null,
  limit = 20,
  offset = 0,
}) {
  const currentVideo = await prisma.video.findUnique({
    where: { video_id: videoId },
    select: {
      video_id: true,
      category: true,
      channel_id: true,
      title: true,
      description: true,
      channel: { select: { content_niche: true } },
    },
  });
  if (!currentVideo) return { items: [], hasMore: false, cold: true };

  let interests = {};
  let topTokens = [];
  let signalCount = 0;
  const stored = profileId
    ? await prisma.user_interest_profile.findUnique({ where: { profile_id: profileId } }).catch((err) => {
      console.error('[up-next] interest-profile failed', err?.message || err);
      return null;
    })
    : null;
  if (stored) {
    interests = stored.interests || {};
    topTokens = stored.top_tokens || [];
    signalCount = stored.signal_count || 0;
  } else if (profileId) {
    const built = await buildInterestProfile(profileId, userId);
    ({ interests, topTokens, signalCount } = built);
  }
  const cold = signalCount < 3 || topTokens.length === 0;

  const currentTokens = videoTokens({
    title: currentVideo.title,
    description: currentVideo.description,
    channel: currentVideo.channel,
    category: currentVideo.category,
  });
  const seedCategory = currentVideo.category || 'General';

  const watchedChannels = new Set();
  const watchedCategories = new Set();
  // Related pool only drops the open video so "More from this channel" is not starved by history.
  // Fill pool also drops recent watches so the tail stays fresher.
  const relatedExcludeIds = new Set([videoId]);
  const fillExcludeIds = new Set([videoId]);
  if (userId) {
    const history = await prisma.watch_history.findMany({
      where: { user_id: userId },
      orderBy: { watched_at: 'desc' },
      take: 80,
      select: { video_id: true, video: { select: { category: true, channel_id: true } } },
    }).catch((err) => {
      console.error('[up-next] watch-history failed', err?.message || err);
      return [];
    });
    for (const h of history) {
      if (h.video_id != null) fillExcludeIds.add(h.video_id);
      if (h.video?.channel_id) watchedChannels.add(h.video.channel_id);
      if (h.video?.category) watchedCategories.add(h.video.category);
    }
  }

  const relatedWhere = visibleVideoWhere({
    video_type: 'long',
    video_id: { notIn: [...relatedExcludeIds] },
  });
  const fillWhere = visibleVideoWhere({
    video_type: 'long',
    video_id: { notIn: [...fillExcludeIds] },
  });

  // Related pools: same-channel is fetched separately so a busy category cannot
  // crowd "More from this channel" out of the candidate cap.
  const relatedOR = [
    { category: seedCategory },
    ...(currentTokens.length ? [{ OR: tokenContainsOR(currentTokens, 'title') }] : []),
    ...(currentTokens.length ? [{ OR: tokenContainsOR(currentTokens, 'description') }] : []),
  ];

  const sameChannelWhere =
    currentVideo.channel_id != null
      ? visibleVideoWhere({
          video_type: 'long',
          channel_id: currentVideo.channel_id,
          video_id: { notIn: [...relatedExcludeIds] },
        })
      : null;

  const logUpNextQueryFail = (label, err) => {
    console.error(`[up-next] ${label} failed`, err?.message || err);
  };

  const [sameChannelPool, relatedPool, backfillPool] = await Promise.all([
    sameChannelWhere
      ? prisma.video.findMany({
          where: sameChannelWhere,
          select: UP_NEXT_CARD_SELECT,
          take: Math.min(40, UP_NEXT_CANDIDATE_CAP),
          orderBy: { created_at: 'desc' },
        }).catch((err) => {
          logUpNextQueryFail('same-channel', err);
          return [];
        })
      : Promise.resolve([]),
    prisma.video.findMany({
      where: { ...relatedWhere, OR: relatedOR },
      select: UP_NEXT_CARD_SELECT,
      take: UP_NEXT_CANDIDATE_CAP,
      orderBy: { created_at: 'desc' },
    }).catch((err) => {
      logUpNextQueryFail('related', err);
      return [];
    }),
    prisma.video.findMany({
      where: fillWhere,
      select: UP_NEXT_CARD_SELECT,
      take: UP_NEXT_BACKFILL_CAP,
      orderBy: [{ views_count: 'desc' }, { created_at: 'desc' }],
    }).catch((err) => {
      logUpNextQueryFail('backfill', err);
      return [];
    }),
  ]);

  const wrapped = new Map();
  for (const v of [...sameChannelPool, ...relatedPool, ...backfillPool]) {
    wrapped.set(v.video_id, wrapUpNextCandidate(v));
  }
  let candidates = [...wrapped.values()];
  if (!candidates.length) return { items: [], hasMore: false, cold };

  const trending = await loadTrendingMap();
  scoreUpNextCandidates(candidates, {
    interests,
    trending,
    currentVideo,
    currentTokens,
    watchedChannels,
    watchedCategories,
    seedVideoId: videoId,
  });

  // Hard rule: related first, then random/popular fill. Diversity is only within each bucket.
  const ordered = orderUpNextRelatedFirst(candidates);
  const relatedOnly = ordered.filter((c) => c._isRelated);
  const fillOnly = ordered.filter((c) => !c._isRelated);
  const rankedRelated = diversityRerank(relatedOnly, relatedOnly.length);
  const rankedFill = diversityRerank(fillOnly, fillOnly.length);
  const woven = [...rankedRelated, ...rankedFill];

  const pageEnd = offset + limit;
  let pageSlice = woven.slice(offset, pageEnd);
  if (!pageSlice.length && offset === 0 && backfillPool.length) {
    pageSlice = backfillPool.slice(0, limit).map(wrapUpNextCandidate).map((c) => ({
      ...c.payload,
      is_recommended: true,
      rec_reason: 'Suggested for you',
    }));
    return { items: pageSlice, hasMore: backfillPool.length > limit, cold };
  }

  const pageItems = pageSlice.map((c) => ({
    ...c.payload,
    is_recommended: true,
    rec_reason: c._reason,
  }));

  return {
    items: pageItems,
    hasMore: woven.length > pageEnd,
    cold,
  };
}
