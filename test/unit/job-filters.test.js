/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import {
  filtersToJobQuery,
  buildPublicJobWhere,
  describeJobSavedSearchFilters,
  normalizeJobSavedSearchFrequency,
  isJobSavedSearchDue,
  stripPagingFromSeekerFilters,
} from '../../utils/job-filters.js';

describe('job-filters', () => {
  it('maps seeker filters to query params', () => {
    expect(filtersToJobQuery({
      keyword: '  node  ',
      location: 'Toronto',
      is_remote: true,
      salary_min: '80000',
      category: '3',
    })).toEqual({
      keyword: 'node',
      location: 'Toronto',
      is_remote: 'true',
      salary_min: 80000,
      category: '3',
    });
  });

  it('does not turn an unchecked remote box into a filter', () => {
    // The seeker UI's default filter state carries is_remote:false and browsing never sends it,
    // so a search saved from that state must not start demanding jobs be explicitly non-remote.
    // jobs.is_remote is nullable, so `where.is_remote = false` would exclude every unset job.
    expect(filtersToJobQuery({ keyword: 'node', is_remote: false })).toEqual({ keyword: 'node' });
    expect(filtersToJobQuery({ keyword: 'node', is_remote: 'false' })).toEqual({ keyword: 'node' });

    // ...and the resulting where must leave is_remote alone, so NULL rows still match.
    expect(buildPublicJobWhere(filtersToJobQuery({ is_remote: false }))).not.toHaveProperty('is_remote');

    // Checking the box still narrows, as it should.
    expect(filtersToJobQuery({ is_remote: true })).toEqual({ is_remote: 'true' });
  });

  it('builds a public job where with open default', () => {
    const where = buildPublicJobWhere({ keyword: 'eng', is_remote: 'true' });
    expect(where.status).toBe('open');
    expect(where.is_remote).toBe(true);
    expect(where.OR).toHaveLength(2);
  });

  it('maps agent_id filter for company pages', () => {
    expect(filtersToJobQuery({ agent_id: '12' })).toEqual({ agent_id: 12 });
    const where = buildPublicJobWhere({ agent_id: '12' });
    expect(where.agent_id).toBe(12);
    expect(where.status).toBe('open');
  });

  it('describes filters and normalizes frequency', () => {
    expect(describeJobSavedSearchFilters({ keyword: 'React', is_remote: true })).toMatch(/React/);
    expect(normalizeJobSavedSearchFrequency('daily')).toBe('daily');
    expect(normalizeJobSavedSearchFrequency('nope')).toBe('immediate');
  });

  it('throttles daily searches to 24h', () => {
    const now = new Date('2026-08-09T12:00:00.000Z');
    expect(isJobSavedSearchDue({ frequency: 'immediate' }, now)).toBe(true);
    expect(isJobSavedSearchDue({
      frequency: 'daily',
      last_notified_at: new Date('2026-08-09T10:00:00.000Z'),
    }, now)).toBe(false);
    expect(isJobSavedSearchDue({
      frequency: 'daily',
      last_notified_at: new Date('2026-08-08T11:00:00.000Z'),
    }, now)).toBe(true);
  });

  it('strips paging keys from stored filters', () => {
    expect(stripPagingFromSeekerFilters({
      keyword: 'x',
      page: 2,
      sort: 'newest',
      limit: 20,
    })).toEqual({ keyword: 'x' });
  });
});
