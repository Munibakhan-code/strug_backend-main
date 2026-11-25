/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import {
  buildTalentPoolWhere,
  clampTalentPoolLimit,
  serializeTalentPoolCandidate,
  queryTalentPoolCandidates,
  TALENT_POOL_DEFAULT_LIMIT,
  TALENT_POOL_MAX_LIMIT,
} from '../../utils/candidate-talent-pool.js';

describe('buildTalentPoolWhere', () => {
  it('requires discoverable + profile signal', () => {
    const w = buildTalentPoolWhere({});
    expect(w.discoverable).toBe(true);
    expect(Array.isArray(w.OR)).toBe(true);
    expect(w.AND).toBeUndefined();
  });

  it('adds keyword and location filters', () => {
    const w = buildTalentPoolWhere({ keyword: 'react', location: 'Toronto' });
    expect(w.AND).toHaveLength(2);
  });

  it('adds years_min when valid', () => {
    const w = buildTalentPoolWhere({ years_min: '3' });
    expect(w.AND?.[0]).toEqual({ years_experience: { gte: 3 } });
  });

  it('ignores invalid years_min', () => {
    const w = buildTalentPoolWhere({ years_min: 'nope' });
    expect(w.AND).toBeUndefined();
  });
});

describe('clampTalentPoolLimit', () => {
  it('defaults and caps', () => {
    expect(clampTalentPoolLimit(undefined)).toBe(TALENT_POOL_DEFAULT_LIMIT);
    expect(clampTalentPoolLimit(999)).toBe(TALENT_POOL_MAX_LIMIT);
    expect(clampTalentPoolLimit(5)).toBe(5);
  });
});

describe('serializeTalentPoolCandidate', () => {
  it('strips to employer-safe shape', () => {
    const out = serializeTalentPoolCandidate({
      candidate_id: 9,
      headline: 'Eng',
      discoverable: true,
      resume_json: { summary: 'Hi' },
      candidate_portfolio_item: [{ portfolio_item_id: 1, title: 'A', url: 'https://x', media_type: 'image' }],
      user: {
        user_id: 2,
        name: 'Sam',
        username: 'sam',
        email: 'secret@x',
        social_profiles: { profile_pic_url: 'https://cdn.example/a.png' },
      },
    });
    expect(out.user.email).toBeUndefined();
    expect(out.user.profile_pic_url).toBe('https://cdn.example/a.png');
    expect(out.portfolio).toHaveLength(1);
    expect(out.headline).toBe('Eng');
  });

  it('returns null for missing', () => {
    expect(serializeTalentPoolCandidate(null)).toBeNull();
  });

  it('maps null avatar when social_profiles missing (edge)', () => {
    const out = serializeTalentPoolCandidate({
      candidate_id: 1,
      user: { user_id: 3, name: 'NoPic', username: 'np' },
    });
    expect(out.user.profile_pic_url).toBeNull();
  });

  it('does not trust a fake user.profile_pic_url field (edge)', () => {
    const out = serializeTalentPoolCandidate({
      candidate_id: 1,
      user: {
        user_id: 3,
        name: 'X',
        username: 'x',
        profile_pic_url: 'https://spoof.example/x.png',
        social_profiles: { profile_pic_url: 'https://cdn.example/real.png' },
      },
    });
    expect(out.user.profile_pic_url).toBe('https://cdn.example/real.png');
  });
});

describe('queryTalentPoolCandidates', () => {
  const now = new Date('2026-09-04T12:00:00.000Z');
  const where = { discoverable: true };

  it('keeps a low-experience boosted seeker when limit is small', async () => {
    const calls = [];
    const db = {
      candidate: {
        findMany: async (args) => {
          calls.push(args);
          const untilGt = args?.where?.AND?.some?.((w) => w?.talent_boosted_until?.gt);
          if (untilGt) {
            return [
              {
                candidate_id: 2,
                years_experience: 1,
                talent_boosted_until: '2026-09-20T00:00:00.000Z',
              },
            ];
          }
          return [
            { candidate_id: 1, years_experience: 20, talent_boosted_until: null },
            { candidate_id: 3, years_experience: 15, talent_boosted_until: null },
          ];
        },
      },
    };

    const rows = await queryTalentPoolCandidates(db, { where, limit: 1, now });
    expect(rows).toHaveLength(1);
    expect(rows[0].candidate_id).toBe(2);
    expect(calls[0].take).toBe(1);
  });

  it('fills remainder from non-boosted and excludes boosted ids', async () => {
    const db = {
      candidate: {
        findMany: async (args) => {
          const untilGt = args?.where?.AND?.some?.((w) => w?.talent_boosted_until?.gt);
          if (untilGt) {
            return [
              {
                candidate_id: 9,
                years_experience: 2,
                talent_boosted_until: '2026-09-20T00:00:00.000Z',
              },
            ];
          }
          expect(args.where.AND.some((w) => w?.candidate_id?.notIn?.includes(9))).toBe(true);
          expect(args.take).toBe(1);
          return [{ candidate_id: 1, years_experience: 10, talent_boosted_until: null }];
        },
      },
    };

    const rows = await queryTalentPoolCandidates(db, { where, limit: 2, now });
    expect(rows.map((r) => r.candidate_id)).toEqual([9, 1]);
  });

  it('returns empty when prisma client is missing', async () => {
    expect(await queryTalentPoolCandidates(null, { where, limit: 5, now })).toEqual([]);
    expect(await queryTalentPoolCandidates({}, { where, limit: 5, now })).toEqual([]);
  });
});
