/**
 * Paid talent-pool boost pricing and window helpers.
 */

export const TALENT_BOOST_PLANS = Object.freeze({
  7: { days: 7, amountCad: 9.99, label: '7 days' },
  14: { days: 14, amountCad: 16.99, label: '14 days' },
  30: { days: 30, amountCad: 29.99, label: '30 days' },
});

export function resolveTalentBoostPlan(daysRaw) {
  const days = Number(daysRaw);
  if (!Number.isFinite(days)) return null;
  return TALENT_BOOST_PLANS[Math.floor(days)] || null;
}

/**
 * Extend boost from now or from an existing future expiry.
 * @param {Date|string|null|undefined} currentUntil
 * @param {number} days
 * @param {Date=} now
 */
export function computeBoostedUntil(currentUntil, days, now = new Date()) {
  const d = Math.floor(Number(days));
  if (!Number.isFinite(d) || d <= 0) {
    throw new Error('days must be a positive number');
  }
  const base = currentUntil && new Date(currentUntil) > now ? new Date(currentUntil) : new Date(now);
  const next = new Date(base);
  next.setUTCDate(next.getUTCDate() + d);
  return next;
}

export function isTalentBoostActive(until, now = new Date()) {
  if (!until) return false;
  const t = new Date(until);
  return !Number.isNaN(t.getTime()) && t > now;
}

/** Prisma orderBy for talent pool: active boosts first, then experience. */
export function talentPoolOrderBy(now = new Date()) {
  // Prisma can't easily "boost first" with a timestamp comparison in orderBy alone,
  // so callers also sort in memory using isTalentBoostActive when needed.
  // Keep a stable DB order as a base.
  return [{ years_experience: 'desc' }, { candidate_id: 'desc' }];
}

export function sortTalentPoolRows(rows, now = new Date()) {
  const list = Array.isArray(rows) ? [...rows] : [];
  list.sort((a, b) => {
    const aBoost = isTalentBoostActive(a?.talent_boosted_until, now) ? 1 : 0;
    const bBoost = isTalentBoostActive(b?.talent_boosted_until, now) ? 1 : 0;
    if (bBoost !== aBoost) return bBoost - aBoost;
    const ay = Number(a?.years_experience) || 0;
    const by = Number(b?.years_experience) || 0;
    if (by !== ay) return by - ay;
    return (Number(b?.candidate_id) || 0) - (Number(a?.candidate_id) || 0);
  });
  return list;
}
