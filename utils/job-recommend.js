/**
 * Jobs Phase 7 — heuristic "Jobs for you" ranking (pure).
 * Signals: skills, location, desired salary, recent applications.
 * Sponsored ads are never injected here — callers use organic open jobs only.
 */

const STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'at', 'with',
  'job', 'jobs', 'role', 'roles', 'senior', 'junior', 'mid', 'level',
]);

/** Split free-text skills into normalized tokens. */
export function parseSkills(skills) {
  if (skills == null || skills === '') return [];
  return String(skills)
    .split(/[,;/|]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length >= 2);
}

/** Loose location tokens for overlap checks. */
export function locationTokens(raw) {
  if (!raw) return [];
  return String(raw)
    .toLowerCase()
    .split(/[\s,;/|-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

export function locationsMatch(candidateLoc, jobLoc) {
  if (!candidateLoc || !jobLoc) return false;
  const a = String(candidateLoc).toLowerCase().trim();
  const b = String(jobLoc).toLowerCase().trim();
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const ta = new Set(locationTokens(a));
  const tb = locationTokens(b);
  return tb.some((t) => ta.has(t));
}

/** Title terms from recent applications (for affinity). */
export function titleTermsFromJobs(jobs = []) {
  const out = new Set();
  for (const j of jobs) {
    const name = String(j?.job_name || '').toLowerCase();
    for (const t of name.split(/[\s,/|+-]+/)) {
      const w = t.trim();
      if (w.length >= 3 && !STOP.has(w)) out.add(w);
    }
  }
  return [...out];
}

/**
 * Build scoring signals from candidate profile + recent apps.
 * @param {{ candidate?: object|null, recentJobs?: object[] }} opts
 */
export function buildRecommendSignals({ candidate = null, recentJobs = [] } = {}) {
  const appliedJobIds = new Set(
    (recentJobs || [])
      .map((j) => Number(j?.job_id))
      .filter((id) => Number.isFinite(id) && id > 0),
  );
  const appliedCategoryIds = new Set(
    (recentJobs || [])
      .map((j) => Number(j?.job_category_id))
      .filter((id) => Number.isFinite(id) && id > 0),
  );
  const desired = candidate?.desired_salary != null ? Number(candidate.desired_salary) : null;
  return {
    skills: parseSkills(candidate?.skills),
    location: candidate?.location ? String(candidate.location).trim() : null,
    desired_salary: Number.isFinite(desired) ? desired : null,
    appliedJobIds,
    appliedCategoryIds,
    appliedTitleTerms: titleTermsFromJobs(recentJobs),
  };
}

/**
 * True when there is at least one thing to rank on. With no skills, no location, no
 * desired salary and no application history every job scores 0, so the "ranking" is just
 * newest-first — the same order the browse list below the rail already uses. Callers
 * return an empty list instead so the rail hides rather than duplicating the list and
 * calling it personalised.
 */
export function hasRecommendSignals(signals) {
  if (!signals) return false;
  return !!(
    (signals.skills || []).length
    || signals.location
    || signals.desired_salary != null
    || (signals.appliedCategoryIds?.size || 0) > 0
    || (signals.appliedTitleTerms || []).length
  );
}

/**
 * Score one open job against seeker signals. Higher = better fit.
 * @param {object} job
 * @param {ReturnType<typeof buildRecommendSignals>} signals
 * @param {Date} [now]
 */
export function scoreJobForCandidate(job, signals, now = new Date()) {
  if (!job || typeof job !== 'object') return 0;
  let score = 0;
  const text = `${job.job_name || ''} ${job.description || ''}`.toLowerCase();

  for (const skill of signals.skills || []) {
    if (skill.length >= 2 && text.includes(skill)) score += 3;
  }

  if (signals.location) {
    if (locationsMatch(signals.location, job.location)) score += 4;
    else if (job.is_remote === true) score += 1;
  }

  if (signals.desired_salary != null) {
    const d = signals.desired_salary;
    const lo = job.salary_min != null ? Number(job.salary_min) : null;
    const hi = job.salary_max != null ? Number(job.salary_max) : null;
    if (lo != null && Number.isFinite(lo) && hi != null && Number.isFinite(hi)) {
      if (d >= lo && d <= hi) score += 3;
      else if (d >= lo * 0.85 && d <= hi * 1.15) score += 2;
    } else if (lo != null && Number.isFinite(lo) && d > 0 && Math.abs(lo - d) / d <= 0.2) {
      score += 2;
    } else if (hi != null && Number.isFinite(hi) && d > 0 && Math.abs(hi - d) / d <= 0.2) {
      score += 1;
    }
  }

  const catId = Number(job.job_category_id);
  if (Number.isFinite(catId) && signals.appliedCategoryIds?.has(catId)) score += 2;

  for (const term of signals.appliedTitleTerms || []) {
    if (term.length >= 3 && text.includes(term)) score += 1;
  }

  if (job.posted_date) {
    const ageDays = (now.getTime() - new Date(job.posted_date).getTime()) / 86400000;
    if (Number.isFinite(ageDays) && ageDays >= 0 && ageDays < 7) score += 1;
  }

  return score;
}

/**
 * Rank open jobs; exclude already-applied; no ads.
 * @returns {object[]} jobs only (no score field)
 */
export function rankRecommendedJobs(jobs, signals, { limit = 8, now = new Date() } = {}) {
  const take = Math.min(Math.max(Number(limit) || 8, 1), 24);
  const applied = signals?.appliedJobIds || new Set();
  const list = (Array.isArray(jobs) ? jobs : []).filter((j) => {
    const id = Number(j?.job_id);
    return Number.isFinite(id) && !applied.has(id) && !(j.sponsored || j.is_ad);
  });

  const scored = list.map((job) => ({
    job,
    score: scoreJobForCandidate(job, signals || buildRecommendSignals(), now),
    posted: job.posted_date ? new Date(job.posted_date).getTime() : 0,
  }));

  scored.sort((a, b) => b.score - a.score || b.posted - a.posted || (Number(b.job.job_id) || 0) - (Number(a.job.job_id) || 0));
  return scored.slice(0, take).map((s) => s.job);
}
