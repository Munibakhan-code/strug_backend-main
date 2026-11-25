/**
 * Analytics metrics SSOT for board-admin Data & Analytics (Phase 0).
 *
 * Definitions are the single source of truth for KPI labels, windows, owners,
 * and drill-down targets. The overview endpoint and FE dictionary both read this.
 */

export const ANALYTICS_WINDOW_DAYS = Object.freeze([7, 30, 90]);
export const DEFAULT_ANALYTICS_DAYS = 30;

/** @typedef {'users'|'commerce'|'marketplace'|'content'|'finance'} MetricDomain */

/**
 * @typedef {object} MetricDef
 * @property {string} id
 * @property {string} label
 * @property {string} shortLabel
 * @property {MetricDomain} domain
 * @property {string} definition
 * @property {string} formula
 * @property {string} owner
 * @property {string} unit  currency | count | ratio | percent
 * @property {{ dashboard: string, item?: string }} drill
 */

/** @type {MetricDef[]} */
export const ANALYTICS_METRICS = Object.freeze([
  {
    id: 'total_users',
    label: 'Total users',
    shortLabel: 'Users',
    domain: 'users',
    definition: 'Count of rows in the user table (all registered accounts).',
    formula: 'COUNT(user)',
    owner: 'User Management',
    unit: 'count',
    drill: { dashboard: 'user-management', item: 'Overview' },
  },
  {
    id: 'signups_window',
    label: 'New signups (window)',
    shortLabel: 'Signups',
    domain: 'users',
    definition: 'Accounts whose social_profile.created_at falls in the selected window (registration proxy; users without a profile are excluded from the daily series).',
    formula: 'COUNT(social_profile WHERE created_at IN window)',
    owner: 'User Management',
    unit: 'count',
    drill: { dashboard: 'user-management', item: 'New Registrations' },
  },
  {
    id: 'gmv_window',
    label: 'Gross merchandise value (window)',
    shortLabel: 'GMV',
    domain: 'commerce',
    definition: 'Sum of paid order / donation / subscription / ad-share amounts across commerce tables in the window. Settles in CAD at the order level.',
    formula: 'SUM(paid order totals ∪ donations ∪ live_subscription credits ∪ revenue_share_log.total_earned)',
    owner: 'Finance',
    unit: 'currency',
    drill: { dashboard: 'finance', item: 'Revenue Overview' },
  },
  {
    id: 'orders_window',
    label: 'Paid orders (window)',
    shortLabel: 'Orders',
    domain: 'commerce',
    definition: 'Count of paid commerce rows that contribute to GMV in the window.',
    formula: 'COUNT(paid rows in GMV union)',
    owner: 'Finance',
    unit: 'count',
    drill: { dashboard: 'finance', item: 'All Transactions' },
  },
  {
    id: 'aov_window',
    label: 'Average order value (window)',
    shortLabel: 'AOV',
    domain: 'commerce',
    definition: 'GMV divided by paid order count in the same window. Zero when there are no orders.',
    formula: 'gmv_window / orders_window',
    owner: 'Finance',
    unit: 'currency',
    drill: { dashboard: 'finance', item: 'Revenue Overview' },
  },
  {
    id: 'wallet_float',
    label: 'Wallet float',
    shortLabel: 'Float',
    domain: 'finance',
    definition: 'Sum of all strug_wallet.balance values (internal ledger float, not Stripe).',
    formula: 'SUM(strug_wallet.balance)',
    owner: 'Finance',
    unit: 'currency',
    drill: { dashboard: 'finance', item: 'Wallet Overview' },
  },
  {
    id: 'active_orders',
    label: 'Active marketplace orders',
    shortLabel: 'Active',
    domain: 'marketplace',
    definition: 'Orders currently in active or scheduled buckets across the cross-vertical operations union.',
    formula: 'COUNT(ops union WHERE bucket IN active, scheduled)',
    owner: 'Operations',
    unit: 'count',
    drill: { dashboard: 'operations', item: 'Overview' },
  },
  {
    id: 'orders_today',
    label: 'Orders today',
    shortLabel: 'Today',
    domain: 'marketplace',
    definition: 'Marketplace order rows (any bucket) with created_at on the current local calendar day.',
    formula: 'COUNT(ops union WHERE created_at >= todayStart)',
    owner: 'Operations',
    unit: 'count',
    drill: { dashboard: 'operations', item: 'Overview' },
  },
  {
    id: 'online_providers',
    label: 'Online providers',
    shortLabel: 'Online',
    domain: 'marketplace',
    definition: 'user_service_provider rows with is_online = true (plus open vendors / live trips surfaced alongside).',
    formula: 'COUNT(user_service_provider WHERE is_online)',
    owner: 'Operations',
    unit: 'count',
    drill: { dashboard: 'operations', item: 'Provider Status' },
  },
  {
    id: 'content_views_total',
    label: 'Content views (lifetime)',
    shortLabel: 'Views',
    domain: 'content',
    definition: 'Sum of video.views_count across the catalog (lifetime counter, not windowed).',
    formula: 'SUM(video.views_count)',
    owner: 'Product / Creator Ops',
    unit: 'count',
    drill: { dashboard: 'analytics', item: 'Engagement Metrics' },
  },
  {
    id: 'content_videos',
    label: 'Videos',
    shortLabel: 'Videos',
    domain: 'content',
    definition: 'Count of video rows in the catalog.',
    formula: 'COUNT(video)',
    owner: 'Product / Creator Ops',
    unit: 'count',
    drill: { dashboard: 'analytics', item: 'Product Usage' },
  },
  {
    id: 'fill_rate',
    label: 'Fill rate (window)',
    shortLabel: 'Fill',
    domain: 'marketplace',
    definition: 'Share of dispatch requests that complete end-to-end in the window (from operations matching aggregates when available).',
    formula: 'completed_requests / total_requests',
    owner: 'Operations',
    unit: 'percent',
    drill: { dashboard: 'analytics', item: 'Fill Rates' },
  },
]);

export function getMetric(id) {
  return ANALYTICS_METRICS.find((m) => m.id === id) || null;
}

export function listMetrics(domain) {
  if (!domain) return [...ANALYTICS_METRICS];
  return ANALYTICS_METRICS.filter((m) => m.domain === domain);
}

/**
 * Clamp analytics window days to the allowed set (or nearest allowed).
 * @param {unknown} raw
 * @param {number} [fallback]
 */
export function clampAnalyticsDays(raw, fallback = DEFAULT_ANALYTICS_DAYS) {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  if (ANALYTICS_WINDOW_DAYS.includes(n)) return n;
  // allow 1..180 for advanced callers, but overview UI uses the preset set
  return Math.min(180, Math.max(1, n));
}

/**
 * Build current + prior windows of equal length ending at `now`.
 * @param {number} days
 * @param {Date} [now]
 */
export function resolveAnalyticsWindows(days, now = new Date()) {
  const end = new Date(now);
  const ms = days * 86400000;
  const start = new Date(end.getTime() - ms);
  const priorEnd = new Date(start.getTime());
  const priorStart = new Date(priorEnd.getTime() - ms);
  return { days, start, end, priorStart, priorEnd };
}

/**
 * Percent change prior → current. Null when prior is 0 and current is 0;
 * +100 when prior is 0 and current > 0.
 * @param {number} current
 * @param {number} prior
 */
export function percentChange(current, prior) {
  const c = Number(current) || 0;
  const p = Number(prior) || 0;
  if (p === 0 && c === 0) return null;
  if (p === 0) return 100;
  return Number((((c - p) / Math.abs(p)) * 100).toFixed(1));
}

/**
 * Attach delta metadata for a KPI pair.
 * @param {number} current
 * @param {number} prior
 */
export function withDelta(current, prior) {
  const c = Number(current) || 0;
  const p = Number(prior) || 0;
  return {
    value: c,
    prior: p,
    delta: c - p,
    deltaPct: percentChange(c, p),
  };
}
