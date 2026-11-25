import { describe, it, expect } from 'vitest';
import {
  INVITE_EXPIRY_DAYS,
  INVITE_DAILY_CAP,
  buildMyRecruitRow,
  buildRecruitShareDescription,
  canResendInvite,
  effectiveInviteStatus,
  filterMyRecruits,
  inviteExpiresAt,
  invitePublicView,
  isInviteExpired,
  parseRecruitIdFromDescription,
  sumEarningsByRecruit,
} from '../../utils/recruit-visibility.js';

describe('recruit-visibility constants', () => {
  it('uses a 14-day invite TTL and a daily invite cap', () => {
    expect(INVITE_EXPIRY_DAYS).toBe(14);
    expect(INVITE_DAILY_CAP).toBe(20);
  });
});

describe('invite expiry', () => {
  const created = new Date('2026-08-01T12:00:00.000Z');

  it('computes expires_at = created_at + 14 days', () => {
    expect(inviteExpiresAt(created).toISOString()).toBe('2026-08-15T12:00:00.000Z');
  });

  it('marks pending invites expired after the TTL', () => {
    const invite = { status: 'pending', created_at: created };
    expect(isInviteExpired(invite, new Date('2026-08-15T11:59:59.000Z'))).toBe(false);
    expect(isInviteExpired(invite, new Date('2026-08-15T12:00:00.000Z'))).toBe(true);
  });

  it('does not expire accepted or declined invites', () => {
    expect(isInviteExpired({ status: 'accepted', created_at: created }, new Date('2026-09-01'))).toBe(false);
    expect(isInviteExpired({ status: 'declined', created_at: created }, new Date('2026-09-01'))).toBe(false);
  });

  it('effectiveInviteStatus returns expired for stale pending', () => {
    const invite = { status: 'pending', created_at: created };
    expect(effectiveInviteStatus(invite, new Date('2026-08-10'))).toBe('pending');
    expect(effectiveInviteStatus(invite, new Date('2026-08-20'))).toBe('expired');
    expect(effectiveInviteStatus({ status: 'accepted', created_at: created }, new Date('2026-08-20'))).toBe('accepted');
  });

  it('canResendInvite only for declined or expired', () => {
    const freshPending = { status: 'pending', created_at: created };
    const stalePending = { status: 'pending', created_at: created };
    const declined = { status: 'declined', created_at: created };
    const accepted = { status: 'accepted', created_at: created };
    const nowFresh = new Date('2026-08-05');
    const nowStale = new Date('2026-08-20');

    expect(canResendInvite(freshPending, nowFresh)).toBe(false);
    expect(canResendInvite(stalePending, nowStale)).toBe(true);
    expect(canResendInvite(declined, nowFresh)).toBe(true);
    expect(canResendInvite(accepted, nowStale)).toBe(false);
  });
});

describe('invitePublicView', () => {
  it('exposes computed status, expires_at, and can_resend for sent side', () => {
    const created = new Date('2026-08-01T00:00:00.000Z');
    const inv = {
      invite_id: 9,
      status: 'pending',
      ref_code: 'STRUG-A',
      created_at: created,
      responded_at: null,
      invited: { user_id: 2, username: 'bob', name: 'Bob' },
    };
    const view = invitePublicView(inv, 'sent', new Date('2026-08-20'));
    expect(view.status).toBe('expired');
    expect(view.can_resend).toBe(true);
    expect(view.expires_at).toBe('2026-08-15T00:00:00.000Z');
    expect(view.user).toEqual({ user_id: 2, username: 'bob', name: 'Bob' });
  });

  it('never sets can_resend on received invites', () => {
    const inv = {
      invite_id: 1,
      status: 'declined',
      ref_code: 'STRUG-A',
      created_at: new Date(),
      responded_at: new Date(),
      recruiter: { user_id: 1, username: 'alice', name: 'Alice' },
    };
    expect(invitePublicView(inv, 'received').can_resend).toBe(false);
  });
});

describe('earnings tagging / attribution', () => {
  it('builds a description with recruit id', () => {
    expect(buildRecruitShareDescription('food', 810)).toBe('Affiliate share from food order · recruit:810');
  });

  it('parses recruit ids from descriptions', () => {
    expect(parseRecruitIdFromDescription('Affiliate share from food order · recruit:810')).toBe(810);
    expect(parseRecruitIdFromDescription('Affiliate share from food order')).toBeNull();
    expect(parseRecruitIdFromDescription(null)).toBeNull();
  });

  it('sums earnings by recruit and tracks unattributed historical rows', () => {
    const { byRecruit, unattributed } = sumEarningsByRecruit([
      { amount: 1.25, description: 'Affiliate share from food order · recruit:810' },
      { amount: 0.5, description: 'Affiliate share from ride order · recruit:810' },
      { amount: 2, description: 'Affiliate share from product order · recruit:811' },
      { amount: 3, description: 'Affiliate share from food order' }, // legacy untagged
    ]);
    expect(byRecruit.get(810)).toBeCloseTo(1.75);
    expect(byRecruit.get(811)).toBe(2);
    expect(unattributed).toBe(3);
  });
});

describe('buildMyRecruitRow + filterMyRecruits', () => {
  const periodStart = new Date('2026-08-01T00:00:00.000Z');

  it('shapes a recruit row with GMV, earnings, and in_period', () => {
    const earnings = new Map([[501, 4.5]]);
    const row = buildMyRecruitRow(
      {
        share_id: 12,
        shared_to: 501,
        created_at: new Date('2026-08-10T00:00:00.000Z'),
        user_shared_ref_code_shared_toTouser: { user_id: 501, username: 'cara', name: 'Cara' },
        checkouts: [{ total: 100 }, { total: 40.5 }],
      },
      earnings,
      periodStart,
    );
    expect(row).toMatchObject({
      share_id: 12,
      in_period: true,
      lifetime_gmv: 140.5,
      earnings_attributed: 4.5,
      user: { user_id: 501, username: 'cara', name: 'Cara' },
    });
    expect(row.linked_at).toBe('2026-08-10T00:00:00.000Z');
  });

  it('marks recruits linked before the period as out of period', () => {
    const row = buildMyRecruitRow(
      {
        share_id: 1,
        shared_to: 9,
        created_at: new Date('2026-07-01T00:00:00.000Z'),
        user_shared_ref_code_shared_toTouser: { user_id: 9, username: 'old', name: 'Old' },
        checkouts: [],
      },
      new Map(),
      periodStart,
    );
    expect(row.in_period).toBe(false);
  });

  it('filters period vs all/active', () => {
    const rows = [
      { share_id: 1, in_period: true },
      { share_id: 2, in_period: false },
    ];
    expect(filterMyRecruits(rows, 'period')).toHaveLength(1);
    expect(filterMyRecruits(rows, 'all')).toHaveLength(2);
    expect(filterMyRecruits(rows, 'active')).toHaveLength(2);
  });
});
