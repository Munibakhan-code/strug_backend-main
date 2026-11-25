import { describe, expect, it } from 'vitest';
import {
  buildDummyEmail,
  buildDummyHandle,
  capCountsToPool,
  computeEngagementCounts,
  DUMMY_EMAIL_SUFFIX,
  MAX_AGE_MULTIPLIER,
  parseEngagementManifest,
  pickComments,
  pickDistinct,
  staggerTimestamps,
  truncateComment,
} from '../../utils/seed-engagement.js';

describe('computeEngagementCounts', () => {
  it('returns views >= likes >= comments on a normal draw', () => {
    const rng = () => 0.5;
    const { views, likes, comments } = computeEngagementCounts({}, rng);
    expect(views).toBeGreaterThan(0);
    expect(likes).toBeLessThanOrEqual(views);
    expect(comments).toBeLessThanOrEqual(likes);
  });

  it('scales views up when ageDays is positive', () => {
    const rng = () => 0;
    const fresh = computeEngagementCounts({ viewsMin: 100, viewsMax: 100, ageDays: 0 }, rng);
    const aged = computeEngagementCounts({ viewsMin: 100, viewsMax: 100, ageDays: 10 }, rng);
    expect(aged.views).toBeGreaterThan(fresh.views);
  });

  it('caps age multiplier so a 2-year-old post is not 37x', () => {
    const rng = () => 0;
    const aged = computeEngagementCounts({ viewsMin: 100, viewsMax: 100, ageDays: 730 }, rng);
    expect(aged.views).toBe(100 * MAX_AGE_MULTIPLIER);
  });

  it('returns zeros when viewsMin and viewsMax are zero', () => {
    const rng = () => 0.99;
    const { views, likes, comments } = computeEngagementCounts({ viewsMin: 0, viewsMax: 0 }, rng);
    expect(views).toBe(0);
    expect(likes).toBe(0);
    expect(comments).toBe(0);
  });
});

describe('pickDistinct', () => {
  it('returns empty array when count is zero', () => {
    expect(pickDistinct([1, 2, 3], 0)).toEqual([]);
  });

  it('never returns duplicate items when pool is large enough', () => {
    const pool = [1, 2, 3, 4, 5];
    const picked = pickDistinct(pool, 3, () => 0.4);
    expect(new Set(picked).size).toBe(3);
  });

  it('caps at pool size when count exceeds pool', () => {
    const picked = pickDistinct(['a', 'b'], 5, () => 0.1);
    expect(picked).toHaveLength(2);
  });
});

describe('staggerTimestamps', () => {
  it('returns strictly ascending timestamps when rng varies', () => {
    let i = 0;
    const values = [0.1, 0.9, 0.3, 0.7, 0.5];
    const rng = () => values[i++ % values.length];
    const times = staggerTimestamps(5, { minAgeMs: 1000, maxAgeMs: 5000, now: 10_000 }, rng);
    expect(times).toHaveLength(5);
    const uniq = new Set(times.map((t) => t.getTime()));
    expect(uniq.size).toBe(5);
    for (let j = 1; j < times.length; j++) {
      expect(times[j].getTime()).toBeGreaterThan(times[j - 1].getTime());
    }
  });

  it('returns empty array for count zero', () => {
    expect(staggerTimestamps(0)).toEqual([]);
  });
});

describe('truncateComment', () => {
  it('passes through short text unchanged', () => {
    expect(truncateComment('hello')).toBe('hello');
  });

  it('truncates text longer than maxLen', () => {
    const long = 'x'.repeat(300);
    expect(truncateComment(long, 280).length).toBe(280);
  });

  it('treats empty string as empty', () => {
    expect(truncateComment('   ')).toBe('');
  });
});

describe('pickComments', () => {
  it('cycles through pool when count exceeds pool length', () => {
    expect(pickComments(['a', 'b'], 5)).toEqual(['a', 'b', 'a', 'b', 'a']);
  });

  it('returns empty when pool is empty', () => {
    expect(pickComments([], 3)).toEqual([]);
  });
});

describe('capCountsToPool', () => {
  it('caps views first then re-derives likes and comments from ratios', () => {
    // 1000 views / 50 likes / 10 comments → pool 100 → views 100, likes 5, comments 1
    expect(capCountsToPool({ views: 1000, likes: 50, comments: 10 }, 100)).toEqual({
      views: 100,
      likes: 5,
      comments: 1,
    });
  });

  it('does not make every dummy like an aged post when pool is small', () => {
    const capped = capCountsToPool({ views: 3700, likes: 200, comments: 40 }, 100);
    expect(capped.views).toBe(100);
    expect(capped.likes).toBeLessThan(capped.views);
    expect(capped.comments).toBeLessThanOrEqual(capped.likes);
  });

  it('handles zero pool', () => {
    expect(capCountsToPool({ views: 10, likes: 5, comments: 2 }, 0)).toEqual({
      views: 0,
      likes: 0,
      comments: 0,
    });
  });
});

describe('parseEngagementManifest', () => {
  it('parses a valid manifest', () => {
    const m = parseEngagementManifest({
      targets: [{ type: 'social', id: 42 }],
      comments: ['nice'],
    });
    expect(m.targets).toEqual([{ type: 'social', id: 42 }]);
    expect(m.comments).toEqual(['nice']);
  });

  it('rejects missing targets', () => {
    expect(() => parseEngagementManifest({ comments: [] })).toThrow(/targets/i);
  });

  it('rejects invalid target type', () => {
    expect(() => parseEngagementManifest({ targets: [{ type: 'blog', id: 1 }] })).toThrow(/social\|townhall\|video/i);
  });

  it('rejects non-numeric target id', () => {
    expect(() => parseEngagementManifest({ targets: [{ type: 'video', id: 'abc' }] })).toThrow(/positive integer/i);
  });
});

describe('dummy identity helpers', () => {
  it('buildDummyEmail ends with dummy suffix', () => {
    expect(buildDummyEmail('test')).toMatch(new RegExp(`${DUMMY_EMAIL_SUFFIX.replace('.', '\\.')}$`));
  });

  it('buildDummyHandle trims to max length', () => {
    expect(buildDummyHandle('a'.repeat(100), 1).length).toBeLessThanOrEqual(50);
  });
});
