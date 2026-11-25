import { describe, expect, it } from 'vitest';
import {
  creatorAnalyticsBucketKey,
  normalizeCreatorAnalyticsRange,
  resolveCreatorAnalyticsRange,
} from '../../utils/creator-analytics-ranges.js';

const NOW = new Date('2026-09-03T14:37:00.000Z');

describe('creator analytics ranges', () => {
  it.each([
    ['24H', '24h'],
    ['7d', '7d'],
    ['30D', '30d'],
    ['90D', '90d'],
    ['1Y', '1y'],
    ['all', 'all'],
    ['unsupported', '30d'],
    [undefined, '30d'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeCreatorAnalyticsRange(input)).toBe(expected);
  });

  it('creates exactly 24 hourly buckets and a matching previous window', () => {
    const range = resolveCreatorAnalyticsRange('24h', null, NOW);

    expect(range.granularity).toBe('hour');
    expect(range.buckets).toHaveLength(24);
    expect(range.buckets[0]).toBe('2026-09-02T15');
    expect(range.buckets.at(-1)).toBe('2026-09-03T14');
    expect(range.previousStart.toISOString()).toBe('2026-09-01T15:00:00.000Z');
    expect(range.previousEnd.toISOString()).toBe('2026-09-02T14:59:59.999Z');
  });

  it.each([['7d', 7], ['30d', 30], ['90d', 90]])('creates %s daily buckets', (input, count) => {
    const range = resolveCreatorAnalyticsRange(input, null, NOW);

    expect(range.granularity).toBe('day');
    expect(range.buckets).toHaveLength(count);
    expect(range.buckets.at(-1)).toBe('2026-09-03');
  });

  it('aggregates one year into readable monthly graph buckets', () => {
    const range = resolveCreatorAnalyticsRange('1y', null, NOW);

    expect(range.granularity).toBe('month');
    expect(range.buckets).toHaveLength(13);
    expect(range.buckets[0]).toBe('2025-09');
    expect(range.buckets.at(-1)).toBe('2026-09');
    expect(range.previousStart).not.toBeNull();
  });

  it('uses true lifetime monthly buckets without inventing a previous period', () => {
    const range = resolveCreatorAnalyticsRange('all', new Date('2026-06-18T10:00:00.000Z'), NOW);

    expect(range.granularity).toBe('month');
    expect(range.start).toBeNull();
    expect(range.previousStart).toBeNull();
    expect(range.buckets).toEqual(['2026-06', '2026-07', '2026-08', '2026-09']);
  });

  it('produces stable UTC keys for every graph granularity', () => {
    const value = '2026-09-03T14:37:00.000Z';
    expect(creatorAnalyticsBucketKey(value, 'hour')).toBe('2026-09-03T14');
    expect(creatorAnalyticsBucketKey(value, 'day')).toBe('2026-09-03');
    expect(creatorAnalyticsBucketKey(value, 'month')).toBe('2026-09');
  });
});
