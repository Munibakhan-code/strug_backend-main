/**
 * Jobs Phase 4 — employer passive candidate (talent pool) search helpers.
 */

import { isTalentBoostActive, sortTalentPoolRows } from './talent-pool-boost.js';

export const TALENT_POOL_MAX_LIMIT = 50;
export const TALENT_POOL_DEFAULT_LIMIT = 20;

const TALENT_POOL_ORDER_BY = Object.freeze([
  { years_experience: 'desc' },
  { candidate_id: 'desc' },
]);

/** Nest base where with an active paid boost window. */
export function withTalentBoostActive(where, now = new Date()) {
  return {
    AND: [where, { talent_boosted_until: { gt: now } }],
  };
}

/** Nest base where with no active boost (null or expired). */
export function withTalentBoostInactive(where, now = new Date()) {
  return {
    AND: [
      where,
      {
        OR: [
          { talent_boosted_until: null },
          { talent_boosted_until: { lte: now } },
        ],
      },
    ],
  };
}

/**
 * Load talent-pool rows so active boosts are never dropped by an experience pre-cut.
 * Fetches up to `limit` boosted matches first, then fills the remainder from non-boosted.
 *
 * @param {{ candidate: { findMany: Function } }} db
 */
export async function queryTalentPoolCandidates(db, { where, limit, include, now = new Date() }) {
  const take = clampTalentPoolLimit(limit);
  const findMany = db?.candidate?.findMany;
  if (typeof findMany !== 'function') return [];

  const boosted = await findMany.call(db.candidate, {
    where: withTalentBoostActive(where, now),
    take,
    orderBy: TALENT_POOL_ORDER_BY,
    include,
  });
  const boostedRows = Array.isArray(boosted) ? boosted : [];
  const need = take - boostedRows.length;
  if (need <= 0) {
    return sortTalentPoolRows(boostedRows, now).slice(0, take);
  }

  const excludeIds = boostedRows
    .map((r) => Number(r?.candidate_id))
    .filter((id) => Number.isFinite(id) && id > 0);
  const inactiveWhere = withTalentBoostInactive(where, now);
  const restWhere = excludeIds.length
    ? { AND: [inactiveWhere, { candidate_id: { notIn: excludeIds } }] }
    : inactiveWhere;

  const rest = await findMany.call(db.candidate, {
    where: restWhere,
    take: need,
    orderBy: TALENT_POOL_ORDER_BY,
    include,
  });
  const restRows = Array.isArray(rest) ? rest : [];
  return sortTalentPoolRows([...boostedRows, ...restRows], now).slice(0, take);
}

/**
 * Only opt-in discoverable seekers with a usable profile signal.
 * @param {Record<string, unknown>} query
 */
export function buildTalentPoolWhere(query = {}) {
  const where = {
    discoverable: true,
    OR: [
      { resume_url: { not: null } },
      { resume_json: { not: null } },
      { headline: { not: null } },
      { skills: { not: null } },
    ],
  };

  const and = [];

  const keyword = String(query.keyword ?? query.q ?? '').trim();
  if (keyword) {
    and.push({
      OR: [
        { headline: { contains: keyword, mode: 'insensitive' } },
        { bio: { contains: keyword, mode: 'insensitive' } },
        { skills: { contains: keyword, mode: 'insensitive' } },
        { location: { contains: keyword, mode: 'insensitive' } },
        { user: { name: { contains: keyword, mode: 'insensitive' } } },
        { user: { username: { contains: keyword, mode: 'insensitive' } } },
      ],
    });
  }

  const location = String(query.location ?? '').trim();
  if (location) {
    and.push({ location: { contains: location, mode: 'insensitive' } });
  }

  const skills = String(query.skills ?? '').trim();
  if (skills) {
    and.push({ skills: { contains: skills, mode: 'insensitive' } });
  }

  if (query.years_min != null && query.years_min !== '') {
    const ymin = Number(query.years_min);
    if (Number.isFinite(ymin) && ymin >= 0) {
      and.push({ years_experience: { gte: Math.floor(ymin) } });
    }
  }

  if (and.length) where.AND = and;
  return where;
}

export function clampTalentPoolLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return TALENT_POOL_DEFAULT_LIMIT;
  return Math.min(TALENT_POOL_MAX_LIMIT, Math.floor(n));
}

/** Strip sensitive fields for employer talent-pool cards. */
export function serializeTalentPoolCandidate(row) {
  if (!row) return null;
  const portfolio = Array.isArray(row.candidate_portfolio_item)
    ? row.candidate_portfolio_item.map((p) => ({
        portfolio_item_id: p.portfolio_item_id,
        title: p.title,
        url: p.url,
        media_type: p.media_type,
      }))
    : [];
  const socialPic = row.user?.social_profiles?.profile_pic_url ?? null;
  return {
    candidate_id: row.candidate_id,
    headline: row.headline,
    bio: row.bio,
    skills: row.skills,
    location: row.location,
    years_experience: row.years_experience,
    desired_salary: row.desired_salary,
    resume_url: row.resume_url,
    resume_json: row.resume_json,
    discoverable: true,
    talent_boosted_until: row.talent_boosted_until ?? null,
    talent_boosted: isTalentBoostActive(row.talent_boosted_until),
    portfolio,
    user: row.user
      ? {
          user_id: row.user.user_id,
          name: row.user.name,
          username: row.user.username,
          profile_pic_url: socialPic,
        }
      : null,
  };
}
