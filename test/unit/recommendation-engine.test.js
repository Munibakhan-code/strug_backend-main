import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/prisma-client.js', () => ({
  default: {
    social_profile: { findUnique: vi.fn() },
    social_bookmark: { findMany: vi.fn() },
    social_interactions: { findMany: vi.fn() },
    social_comments: { findMany: vi.fn() },
    social_post_view: { findMany: vi.fn() },
    content_impression: { findMany: vi.fn() },
    follower: { findMany: vi.fn() },
    video_likes: { findMany: vi.fn() },
    video_watch_later: { findMany: vi.fn() },
    watch_history: { findMany: vi.fn() },
    video_search_history: { findMany: vi.fn() },
  },
}));

import prisma from '../../utils/prisma-client.js';
import {
  SIGNAL_WEIGHTS,
  extractTokens,
  buildInterestProfile,
  scoreUpNextCandidates,
  orderUpNextRelatedFirst,
  seededJitter,
} from '../../utils/recommendation-engine.js';

describe('recommendation-engine interest signals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.social_bookmark.findMany.mockResolvedValue([]);
    prisma.social_interactions.findMany.mockResolvedValue([]);
    prisma.social_comments.findMany.mockResolvedValue([]);
    prisma.social_post_view.findMany.mockResolvedValue([]);
    prisma.content_impression.findMany.mockResolvedValue([]);
    prisma.follower.findMany.mockResolvedValue([]);
    prisma.video_likes.findMany.mockResolvedValue([]);
    prisma.video_watch_later.findMany.mockResolvedValue([]);
    prisma.watch_history.findMany.mockResolvedValue([]);
    prisma.video_search_history.findMany.mockResolvedValue([]);
  });

  it('exposes a vsearch weight for video search intent', () => {
    expect(SIGNAL_WEIGHTS.vsearch).toBeGreaterThan(0);
    expect(SIGNAL_WEIGHTS.vsearch).toBeLessThan(SIGNAL_WEIGHTS.vlike);
  });

  it('tokenises search-style queries the same way as titles', () => {
    const tokens = extractTokens('beginner chess openings tutorial');
    expect(tokens).toEqual(expect.arrayContaining(['chess', 'openings', 'tutorial']));
    expect(tokens).not.toContain('for');
  });

  it('folds recent video searches into the interest vector', async () => {
    prisma.watch_history.findMany.mockResolvedValue([
      {
        watched_at: new Date(),
        last_position: 60,
        video: {
          title: 'Morning yoga stretch',
          description: '',
          video_type: 'long',
          duration_sec: 120,
          channel: { content_niche: 'Fitness' },
        },
      },
    ]);
    prisma.video_search_history.findMany.mockResolvedValue([
      { query: 'street food karachi', result_count: 12, created_at: new Date() },
      { query: 'indie game remake', result_count: 0, created_at: new Date() },
    ]);

    const { topTokens, signalCount, interests } = await buildInterestProfile(9, 42);

    expect(prisma.video_search_history.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { user_id: 42 } }),
    );
    expect(signalCount).toBeGreaterThanOrEqual(3);
    expect(topTokens).toEqual(expect.arrayContaining(['food', 'karachi', 'indie', 'game']));
    expect(interests.yoga || interests.stretch || interests.fitness).toBeTruthy();
  });

  it('dedupes repeated search queries and boosts zero-result demand', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T12:00:00Z'));
    try {
      prisma.video_search_history.findMany.mockResolvedValue([
        { query: 'Chess Openings', result_count: 0, created_at: new Date('2026-08-24T12:00:00Z') },
        { query: 'chess openings', result_count: 0, created_at: new Date('2026-08-24T11:00:00Z') },
        { query: 'chess openings', result_count: 5, created_at: new Date('2026-08-24T10:00:00Z') },
      ]);
      const { signalCount, interests } = await buildInterestProfile(1, 7);
      // One unique query → one signal, not three.
      expect(signalCount).toBe(1);
      // Zero-result boost (1.25×) on top of base vsearch weight; freeze time so decay ≈ 1.
      expect(interests.chess).toBe(SIGNAL_WEIGHTS.vsearch * 1.25);
      expect(interests.chess).toBeGreaterThan(SIGNAL_WEIGHTS.vsearch);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips empty search queries after tokenisation', async () => {
    prisma.video_search_history.findMany.mockResolvedValue([
      { query: 'the and for', result_count: 0, created_at: new Date() },
      { query: '   ', result_count: 0, created_at: new Date() },
      { query: null, result_count: 0, created_at: new Date() },
    ]);
    const { signalCount, topTokens } = await buildInterestProfile(1, 7);
    expect(signalCount).toBe(0);
    expect(topTokens).toEqual([]);
  });
});

describe('Up Next hybrid ranker', () => {
  const trending = { map: { chess: 10, food: 5 }, max: 10 };

  function candidate(id, { channelId = 1, category = 'Gaming', tokens = ['chess', 'openings'], createdAt = new Date() } = {}) {
    return {
      content_type: 'video',
      id,
      channelId,
      category,
      tokens,
      topToken: tokens[0] ?? null,
      authorId: channelId,
      createdAt,
      metrics: { likes: 10, comments: 2, saves: 0, createdAt },
      payload: { video_id: id, title: 't', category },
    };
  }

  it('ranks same-channel videos above unrelated popular ones', () => {
    const currentVideo = { channel_id: 99, category: 'Gaming' };
    const sameChannel = candidate(1, { channelId: 99, tokens: ['game'], category: 'Gaming' });
    const otherPopular = candidate(2, { channelId: 50, tokens: ['news'], category: 'News' });
    otherPopular.metrics.likes = 500;
    scoreUpNextCandidates([sameChannel, otherPopular], {
      interests: {},
      trending,
      currentVideo,
      currentTokens: ['game'],
      seedVideoId: 11,
    });
    expect(sameChannel._score).toBeGreaterThan(otherPopular._score);
    expect(sameChannel._isRelated).toBe(true);
    expect(otherPopular._isRelated).toBe(false);
    expect(sameChannel._reason).toBe('More from this channel');
  });

  it('puts every related video before any fill / random suggestion', () => {
    const currentVideo = { channel_id: 99, category: 'Gaming' };
    const relatedA = candidate(1, { channelId: 99, tokens: ['game'], category: 'Gaming' });
    const relatedB = candidate(2, { channelId: 88, tokens: ['chess'], category: 'Gaming' });
    const fill = candidate(3, { channelId: 50, tokens: ['news'], category: 'News' });
    fill.metrics.likes = 9999;
    scoreUpNextCandidates([fill, relatedB, relatedA], {
      interests: { news: 100 },
      trending,
      currentVideo,
      currentTokens: ['game'],
      seedVideoId: 11,
    });
    const ordered = orderUpNextRelatedFirst([fill, relatedB, relatedA]);
    expect(ordered.map((c) => c.id)).toEqual([1, 2, 3]);
    expect(ordered[0]._isRelated && ordered[1]._isRelated).toBe(true);
    expect(ordered[2]._isRelated).toBe(false);
  });

  it('uses personal interests when context is weak', () => {
    const a = candidate(1, { channelId: 10, category: 'Music', tokens: ['jazz', 'night', 'study'] });
    const b = candidate(2, { channelId: 11, category: 'Sports', tokens: ['football'] });
    scoreUpNextCandidates([a, b], {
      interests: { jazz: 20, night: 15, study: 10 },
      trending,
      currentVideo: { channel_id: 999, category: 'Tech' },
      currentTokens: ['react'],
      seedVideoId: 7,
    });
    expect(a._isRelated).toBe(false);
    expect(b._isRelated).toBe(false);
    expect(a._score).toBeGreaterThan(b._score);
  });

  it('keeps jitter stable per seed video', () => {
    expect(seededJitter(11, 5)).toBe(seededJitter(11, 5));
    expect(seededJitter(11, 5)).not.toBe(seededJitter(12, 5));
  });
});
