import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_METRICS,
  clampAnalyticsDays,
  getMetric,
  listMetrics,
  percentChange,
  resolveAnalyticsWindows,
  withDelta,
} from '../../utils/analytics-metrics.js';

describe('analytics-metrics SSOT', () => {
  it('lists core KPI definitions with drill targets', () => {
    expect(ANALYTICS_METRICS.length).toBeGreaterThanOrEqual(8);
    const gmv = getMetric('gmv_window');
    expect(gmv?.unit).toBe('currency');
    expect(gmv?.drill?.dashboard).toBe('finance');
  });

  it('filters by domain and returns empty for unknown domain', () => {
    expect(listMetrics('commerce').every((m) => m.domain === 'commerce')).toBe(true);
    expect(listMetrics('nope')).toEqual([]);
  });

  it('clamps window days to presets or bounded ints', () => {
    expect(clampAnalyticsDays(30)).toBe(30);
    expect(clampAnalyticsDays('7')).toBe(7);
    expect(clampAnalyticsDays(undefined)).toBe(30);
    expect(clampAnalyticsDays('abc')).toBe(30);
    expect(clampAnalyticsDays(0)).toBe(1);
    expect(clampAnalyticsDays(999)).toBe(180);
  });

  it('builds equal-length current and prior windows', () => {
    const now = new Date('2026-09-23T12:00:00.000Z');
    const w = resolveAnalyticsWindows(30, now);
    expect(w.days).toBe(30);
    expect(w.end.toISOString()).toBe(now.toISOString());
    expect(w.start.toISOString()).toBe('2026-08-24T12:00:00.000Z');
    expect(w.priorEnd.toISOString()).toBe(w.start.toISOString());
    expect(w.priorStart.toISOString()).toBe('2026-07-25T12:00:00.000Z');
  });

  it('computes percent change with zero-prior edges', () => {
    expect(percentChange(0, 0)).toBeNull();
    expect(percentChange(10, 0)).toBe(100);
    expect(percentChange(110, 100)).toBe(10);
    expect(percentChange(90, 100)).toBe(-10);
  });

  it('withDelta packages value, prior, delta, and deltaPct', () => {
    expect(withDelta(120, 100)).toEqual({
      value: 120,
      prior: 100,
      delta: 20,
      deltaPct: 20,
    });
    expect(withDelta(undefined, null)).toEqual({
      value: 0,
      prior: 0,
      delta: 0,
      deltaPct: null,
    });
  });
});
