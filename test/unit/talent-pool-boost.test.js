/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import {
  computeBoostedUntil,
  isTalentBoostActive,
  resolveTalentBoostPlan,
  sortTalentPoolRows,
} from '../../utils/talent-pool-boost.js';

describe('resolveTalentBoostPlan', () => {
  it('resolves known plans', () => {
    expect(resolveTalentBoostPlan(7)?.amountCad).toBe(9.99);
    expect(resolveTalentBoostPlan('30')?.days).toBe(30);
  });

  it('rejects unknown days', () => {
    expect(resolveTalentBoostPlan(3)).toBeNull();
  });
});

describe('computeBoostedUntil', () => {
  it('extends from now when no prior boost', () => {
    const now = new Date('2026-09-04T12:00:00.000Z');
    const until = computeBoostedUntil(null, 7, now);
    expect(until.toISOString()).toBe('2026-09-11T12:00:00.000Z');
  });

  it('stacks onto a future expiry', () => {
    const now = new Date('2026-09-04T12:00:00.000Z');
    const current = new Date('2026-09-10T12:00:00.000Z');
    const until = computeBoostedUntil(current, 7, now);
    expect(until.toISOString()).toBe('2026-09-17T12:00:00.000Z');
  });
});

describe('sortTalentPoolRows', () => {
  it('puts active boosts first', () => {
    const now = new Date('2026-09-04T12:00:00.000Z');
    const rows = sortTalentPoolRows(
      [
        { candidate_id: 1, years_experience: 10, talent_boosted_until: null },
        { candidate_id: 2, years_experience: 2, talent_boosted_until: '2026-09-20T00:00:00.000Z' },
      ],
      now,
    );
    expect(rows[0].candidate_id).toBe(2);
    expect(isTalentBoostActive(rows[0].talent_boosted_until, now)).toBe(true);
  });
});
