/**
 * Shared Jobs browse filter helpers (list API + saved-search alerts).
 */

export const JOB_SAVED_SEARCH_FREQUENCIES = ['immediate', 'daily'];

/** Normalize a saved-search / UI filters blob into GET /job query shape. */
export function filtersToJobQuery(filters = {}) {
  const f = filters && typeof filters === 'object' ? filters : {};
  const query = {};
  if (f.keyword?.trim()) query.keyword = String(f.keyword).trim();
  if (f.location?.trim()) query.location = String(f.location).trim();
  if (f.category) query.category = String(f.category);
  if (f.employment_type) query.employment_type = String(f.employment_type);
  // Only `true` narrows. The seeker UI keeps `is_remote: false` in its default filter state and
  // never sends it when browsing (seekerJobs.js only emits is_remote="true"), so a saved search
  // built from that blob must not invent a filter the user's own search didn't apply. It matters
  // because jobs.is_remote is nullable and defaults to NULL, so `where.is_remote = false` would
  // drop every job whose remote flag was never set — i.e. most of them — and the alert would
  // silently match a fraction of what the search returned.
  if (f.is_remote === true || f.is_remote === 'true') query.is_remote = 'true';
  if (f.salary_min !== '' && f.salary_min != null) query.salary_min = Number(f.salary_min);
  if (f.salary_max !== '' && f.salary_max != null) query.salary_max = Number(f.salary_max);
  if (f.status) query.status = String(f.status);
  if (f.agent_id != null && f.agent_id !== '') query.agent_id = Number(f.agent_id);
  return query;
}

/** Build Prisma where for public job browse (defaults to open). */
export function buildPublicJobWhere(query = {}) {
  const where = {};
  where.status = query.status ? String(query.status) : 'open';
  if (query.category) where.job_category_id = parseInt(query.category, 10);
  if (query.agent_id != null && query.agent_id !== '' && !Number.isNaN(Number(query.agent_id))) {
    where.agent_id = Number(query.agent_id);
  }
  if (query.location) where.location = { contains: String(query.location), mode: 'insensitive' };
  if (query.is_remote === 'true') where.is_remote = true;
  if (query.is_remote === 'false') where.is_remote = false;
  if (query.employment_type) where.employment_type = String(query.employment_type);
  if (query.salary_min != null && query.salary_min !== '' && !Number.isNaN(Number(query.salary_min))) {
    where.salary_min = { gte: Number(query.salary_min) };
  }
  if (query.salary_max != null && query.salary_max !== '' && !Number.isNaN(Number(query.salary_max))) {
    where.AND = [
      ...(where.AND || []),
      {
        OR: [
          { salary_max: { lte: Number(query.salary_max) } },
          { AND: [{ salary_max: null }, { salary_min: { lte: Number(query.salary_max) } }] },
        ],
      },
    ];
  }
  if (query.keyword) {
    where.OR = [
      { job_name: { contains: String(query.keyword), mode: 'insensitive' } },
      { description: { contains: String(query.keyword), mode: 'insensitive' } },
    ];
  }
  return where;
}

export function describeJobSavedSearchFilters(filters = {}) {
  const f = filters && typeof filters === 'object' ? filters : {};
  const bits = [];
  if (f.keyword?.trim()) bits.push(String(f.keyword).trim());
  if (f.location?.trim()) bits.push(String(f.location).trim());
  if (f.employment_type) bits.push(String(f.employment_type).replace(/_/g, ' '));
  if (f.is_remote === true || f.is_remote === 'true') bits.push('Remote');
  if (f.salary_min != null && f.salary_min !== '') bits.push(`≥ $${Number(f.salary_min).toLocaleString()}`);
  if (f.salary_max != null && f.salary_max !== '') bits.push(`≤ $${Number(f.salary_max).toLocaleString()}`);
  return bits.length ? bits.join(' · ') : 'Saved job search';
}

export function normalizeJobSavedSearchFrequency(raw) {
  const v = String(raw || 'immediate').toLowerCase();
  return JOB_SAVED_SEARCH_FREQUENCIES.includes(v) ? v : 'immediate';
}

/** Whether a daily search is due given last_notified_at / created_at. */
export function isJobSavedSearchDue(search, now = new Date()) {
  const freq = normalizeJobSavedSearchFrequency(search?.frequency);
  if (freq !== 'daily') return true;
  const since = search?.last_notified_at || search?.created_at;
  if (!since) return true;
  const ms = now.getTime() - new Date(since).getTime();
  return ms >= 24 * 60 * 60 * 1000;
}

export function stripPagingFromSeekerFilters(filters = {}) {
  const {
    page: _page,
    sort: _sort,
    limit: _limit,
    offset: _offset,
    ...rest
  } = filters && typeof filters === 'object' ? filters : {};
  return rest;
}
