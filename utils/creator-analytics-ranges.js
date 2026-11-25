const SUPPORTED_RANGES = new Set(['24h', '7d', '30d', '90d', '1y', 'all']);

export function normalizeCreatorAnalyticsRange(value) {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  return SUPPORTED_RANGES.has(normalized) ? normalized : '30d';
}
export function creatorAnalyticsBucketKey(value, granularity) {
  const iso = new Date(value).toISOString();
  if (granularity === 'hour') return iso.slice(0, 13);
  if (granularity === 'month') return iso.slice(0, 7);
  return iso.slice(0, 10);
}

export function resolveCreatorAnalyticsRange(requestedRange, earliestDate = null, nowValue = new Date()) {
  const range = normalizeCreatorAnalyticsRange(requestedRange);
  const now = new Date(nowValue);

  if (range === '24h') {
    const start = new Date(now);
    start.setUTCMinutes(0, 0, 0);
    start.setUTCHours(start.getUTCHours() - 23);
    const previousEnd = new Date(start.getTime() - 1);
    const previousStart = new Date(start.getTime() - (24 * 60 * 60 * 1000));
    const buckets = Array.from({ length: 24 }, (_, index) => {
      const date = new Date(start);
      date.setUTCHours(date.getUTCHours() + index);
      return creatorAnalyticsBucketKey(date, 'hour');
    });
    return { range, start, end: now, previousStart, previousEnd, buckets, granularity: 'hour' };
  }

  if (range === 'all') {
    const start = earliestDate ? new Date(earliestDate) : new Date(now);
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    const buckets = [];
    const cursor = new Date(start);
    do {
      buckets.push(creatorAnalyticsBucketKey(cursor, 'month'));
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    } while (cursor <= now);
    return { range, start: null, end: now, previousStart: null, previousEnd: null, buckets, granularity: 'month' };
  }

  if (range === '1y') {
    const days = 365;
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - (days - 1));
    const previousEnd = new Date(start.getTime() - 1);
    const previousStart = new Date(previousEnd);
    previousStart.setUTCDate(previousStart.getUTCDate() - (days - 1));
    previousStart.setUTCHours(0, 0, 0, 0);
    const buckets = [];
    const cursor = new Date(start);
    cursor.setUTCDate(1);
    do {
      buckets.push(creatorAnalyticsBucketKey(cursor, 'month'));
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    } while (cursor <= now);
    return { range, start, end: now, previousStart, previousEnd, buckets, granularity: 'month' };
  }

  const days = range === '7d' ? 7 : range === '90d' ? 90 : 30;
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const previousEnd = new Date(start.getTime() - 1);
  const previousStart = new Date(previousEnd);
  previousStart.setUTCDate(previousStart.getUTCDate() - (days - 1));
  previousStart.setUTCHours(0, 0, 0, 0);
  const buckets = Array.from({ length: days }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + index);
    return creatorAnalyticsBucketKey(date, 'day');
  });
  return { range, start, end: now, previousStart, previousEnd, buckets, granularity: 'day' };
}
