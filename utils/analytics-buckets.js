// Shared daily-bucket time-series helpers for seller analytics dashboards.
//
// Mirrors the toolkit originally inlined in routes/channel-routes.js so the
// per-vertical "analytics overview" endpoints (food vendor / rideshare driver /
// product seller / creator earnings) all return an identical, range-aware shape
// that the frontend AnalyticsPanel can render generically. Buckets are filled in
// JS after a findMany (no raw SQL), matching the existing channel-routes pattern.
//
// Day boundaries use a business / client IANA timezone (not raw UTC midnight) so
// a late-evening local order lands on the seller's calendar day — same idea as
// Overview's local chart buckets. Pass `timeZone` from req.query.tz when available.

import {
	BUSINESS_TIMEZONE,
	calendarDayKey,
	isValidTimeZone,
	nextStartOfDayInTimeZone,
	previousStartOfDayInTimeZone,
	startOfDayInTimeZone,
} from './business-time.js';

export const RANGE_DAYS = { '7d': 7, '28d': 28, '90d': 90, '365d': 365, 'lifetime': 365 };

export function resolveRangeParam(raw) {
	return RANGE_DAYS[raw] ? raw : '28d';
}

/** Prefer a valid client IANA zone; otherwise the platform business timezone. */
export function resolveAnalyticsTimeZone(raw) {
	if (typeof raw === 'string') {
		const tz = raw.trim();
		if (isValidTimeZone(tz)) return tz;
	}
	return BUSINESS_TIMEZONE;
}

// Returns the inclusive [start, now] window for `days` in `timeZone`, plus the
// immediately preceding equal-length window ([prevStart, prevEnd]) used for % deltas.
// `start` / `prevStart` are local midnights expressed as UTC Date instants.
export function resolveRange(days, timeZone = BUSINESS_TIMEZONE) {
	const zone = resolveAnalyticsTimeZone(timeZone);
	const now = new Date();
	let start = startOfDayInTimeZone(now, zone);
	for (let i = 1; i < days; i++) {
		start = previousStartOfDayInTimeZone(start, zone);
	}
	const prevEnd = new Date(start.getTime() - 1);
	let prevStart = startOfDayInTimeZone(prevEnd, zone);
	for (let i = 1; i < days; i++) {
		prevStart = previousStartOfDayInTimeZone(prevStart, zone);
	}
	return { start, prevStart, prevEnd, timeZone: zone };
}

export function dayKey(d, timeZone = BUSINESS_TIMEZONE) {
	return calendarDayKey(d, resolveAnalyticsTimeZone(timeZone));
}

export function buildDateBuckets(start, days, timeZone = BUSINESS_TIMEZONE) {
	const zone = resolveAnalyticsTimeZone(timeZone);
	const buckets = [];
	let cursor = startOfDayInTimeZone(start, zone);
	for (let i = 0; i < days; i++) {
		buckets.push(calendarDayKey(cursor, zone));
		cursor = nextStartOfDayInTimeZone(cursor, zone);
	}
	return buckets;
}

export function pctChange(curr, prev) {
	if (prev === 0) return curr > 0 ? 100 : 0;
	return parseFloat((((curr - prev) / prev) * 100).toFixed(1));
}

export function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

/**
 * Build the unified summary + daily timeseries (gross / net / count per day)
 * for a set of revenue rows, plus prev-period % deltas.
 *
 * @param {object}   o
 * @param {object[]} o.rows       current-period rows
 * @param {object[]} o.prevRows   previous-period rows (for deltas); may be []
 * @param {string}   o.dateField  row key holding the bucketing date
 * @param {(r:any)=>number} o.gross  gross revenue extractor for a row
 * @param {(r:any)=>number} o.net    net (seller take-home) extractor for a row
 * @param {Date}     o.start      window start (from resolveRange)
 * @param {number}   o.days       window length
 * @param {string}   [o.timeZone] IANA zone for day keys (default business TZ)
 * @returns {{ timeseries: Array, summary: object }}
 */
export function buildEarningsSeries({ rows, prevRows = [], dateField, gross, net, start, days, timeZone = BUSINESS_TIMEZONE }) {
	const zone = resolveAnalyticsTimeZone(timeZone);
	const buckets = buildDateBuckets(start, days, zone);
	const idx = new Map(buckets.map((d, i) => [d, i]));
	const tsGross = new Array(buckets.length).fill(0);
	const tsNet = new Array(buckets.length).fill(0);
	const tsCount = new Array(buckets.length).fill(0);

	let sumGross = 0, sumNet = 0;
	for (const r of rows) {
		const g = gross(r) || 0;
		const n = net(r) || 0;
		sumGross += g; sumNet += n;
		const dv = r[dateField];
		if (!dv) continue;
		const i = idx.get(dayKey(dv, zone));
		if (i == null) continue;
		tsGross[i] += g; tsNet[i] += n; tsCount[i] += 1;
	}

	let prevGross = 0, prevNet = 0;
	for (const r of prevRows) { prevGross += gross(r) || 0; prevNet += net(r) || 0; }

	const count = rows.length;
	const prevCount = prevRows.length;

	const timeseries = buckets.map((date, i) => ({
		date, gross: round2(tsGross[i]), net: round2(tsNet[i]), count: tsCount[i],
	}));

	return {
		timeseries,
		summary: {
			gross: round2(sumGross),
			gross_change_pct: pctChange(round2(sumGross), round2(prevGross)),
			net: round2(sumNet),
			net_change_pct: pctChange(round2(sumNet), round2(prevNet)),
			count,
			count_change_pct: pctChange(count, prevCount),
			avg_order_value: count > 0 ? round2(sumGross / count) : 0,
		},
	};
}
