/**
 * Pure helpers for seed feed engagement assignment (DB-direct cold-start tooling).
 * Used by scripts/seed-engagement-assign.mjs — see GitHub issue #1220.
 */

export const DUMMY_EMAIL_SUFFIX = '@strug-dummy.ca';

export const DEFAULT_RATIOS = {
  viewsMin: 50,
  viewsMax: 500,
  likeRateMin: 0.03,
  likeRateMax: 0.08,
  commentRateMin: 0.1,
  commentRateMax: 0.25,
};

/** Cap age boost so a 2-year-old post does not get a 37× view multiplier. */
export const MAX_AGE_MULTIPLIER = 3;

const TARGET_TYPES = new Set(['social', 'townhall', 'video']);

/** @param {() => number} [rng] */
export function computeEngagementCounts(options = {}, rng = Math.random) {
  const {
    viewsMin = DEFAULT_RATIOS.viewsMin,
    viewsMax = DEFAULT_RATIOS.viewsMax,
    likeRateMin = DEFAULT_RATIOS.likeRateMin,
    likeRateMax = DEFAULT_RATIOS.likeRateMax,
    commentRateMin = DEFAULT_RATIOS.commentRateMin,
    commentRateMax = DEFAULT_RATIOS.commentRateMax,
    ageDays = 0,
  } = options;

  const span = Math.max(0, viewsMax - viewsMin);
  let views = viewsMin + Math.floor(rng() * (span + 1));
  if (ageDays > 0) {
    const ageMult = Math.min(1 + ageDays * 0.05, MAX_AGE_MULTIPLIER);
    views = Math.floor(views * ageMult);
  }

  const likeRate = likeRateMin + rng() * Math.max(0, likeRateMax - likeRateMin);
  let likes = Math.floor(views * likeRate);
  likes = Math.max(0, Math.min(likes, views));

  const commentRate = commentRateMin + rng() * Math.max(0, commentRateMax - commentRateMin);
  let comments = likes > 0 ? Math.floor(likes * commentRate) : 0;
  comments = Math.max(0, Math.min(comments, likes));

  return { views, likes, comments };
}

/** Pick up to `count` distinct items from `pool` without replacement. */
export function pickDistinct(pool, count, rng = Math.random) {
  if (!Array.isArray(pool) || count <= 0) return [];
  if (count >= pool.length) return shuffleInPlace([...pool], rng);
  const copy = [...pool];
  const out = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(rng() * copy.length);
    out.push(copy[idx]);
    copy.splice(idx, 1);
  }
  return out;
}

export function shuffleInPlace(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Spread timestamps between (now - maxAgeMs) and (now - minAgeMs), sorted ascending.
 * @param {number} count
 * @param {{ minAgeMs?: number, maxAgeMs?: number, now?: number }} [opts]
 * @param {() => number} [rng]
 */
export function staggerTimestamps(count, opts = {}, rng = Math.random) {
  if (count <= 0) return [];
  const {
    minAgeMs = 60_000,
    maxAgeMs = 7 * 24 * 60 * 60 * 1000,
    now = Date.now(),
  } = opts;
  const start = now - maxAgeMs;
  const end = now - minAgeMs;
  const span = Math.max(1, end - start);
  const times = [];
  for (let i = 0; i < count; i++) {
    times.push(new Date(start + Math.floor(rng() * span)));
  }
  return times.sort((a, b) => a.getTime() - b.getTime());
}

export function buildDummyEmail(handle) {
  const safe = String(handle || 'fan').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 32);
  const hash = Math.random().toString(16).slice(2, 10);
  return `dummy_${safe}_${hash}${DUMMY_EMAIL_SUFFIX}`;
}

export function buildDummyHandle(base, index) {
  const slug = String(base || 'fan')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 20);
  return `${slug}${index}`.slice(0, 50);
}

export function truncateComment(text, maxLen = 280) {
  const s = String(text || '').trim();
  if (!s) return '';
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1)}…`;
}

/** Pick comment texts cyclically from scraped pool. */
export function pickComments(pool, count) {
  if (!Array.isArray(pool) || count <= 0) return [];
  const cleaned = pool.map((t) => truncateComment(t)).filter(Boolean);
  if (!cleaned.length) return [];
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(cleaned[i % cleaned.length]);
  }
  return out;
}

/**
 * Validate manifest JSON shape from seed-engagement-assign.mjs.
 * @param {unknown} raw
 */
export function parseEngagementManifest(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Manifest must be a JSON object');
  }
  const m = /** @type {Record<string, unknown>} */ (raw);
  const targets = m.targets;
  if (!Array.isArray(targets) || !targets.length) {
    throw new Error('Manifest must include a non-empty "targets" array');
  }

  const parsedTargets = targets.map((t, i) => {
    if (!t || typeof t !== 'object') throw new Error(`targets[${i}] must be an object`);
    const row = /** @type {Record<string, unknown>} */ (t);
    const type = String(row.type || '').toLowerCase();
    const id = Number(row.id);
    if (!TARGET_TYPES.has(type)) {
      throw new Error(`targets[${i}].type must be social|townhall|video`);
    }
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`targets[${i}].id must be a positive integer`);
    }
    return { type, id };
  });

  const comments = Array.isArray(m.comments)
    ? m.comments.map((c) => truncateComment(c)).filter(Boolean)
    : [];

  const ratios = { ...DEFAULT_RATIOS, ...(m.ratios && typeof m.ratios === 'object' ? m.ratios : {}) };

  return { targets: parsedTargets, comments, ratios };
}

/**
 * Cap views to the seed pool, then re-derive likes/comments from the capped views
 * so likeRateMin/Max still apply. Independent min() against the same pool would
 * clamp aged posts to "every dummy likes every post".
 */
export function capCountsToPool(counts, poolSize) {
  const size = Math.max(0, poolSize);
  const views = Math.min(Math.max(0, counts.views), size);
  if (views <= 0) return { views: 0, likes: 0, comments: 0 };

  const likeRate = counts.views > 0 ? counts.likes / counts.views : 0;
  const likes = Math.min(Math.floor(views * likeRate), views);

  const commentRate = counts.likes > 0 ? counts.comments / counts.likes : 0;
  const comments = likes > 0 ? Math.min(Math.floor(likes * commentRate), likes) : 0;

  return { views, likes, comments };
}
