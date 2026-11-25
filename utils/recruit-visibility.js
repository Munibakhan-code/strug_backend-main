// Recruiter Phase 1 — multi-ongoing recruit visibility helpers.
// Pure logic (invite TTL, rate-cap constants, recruit list shaping, earnings tagging)
// so unit tests do not need Express/Prisma.

export const INVITE_EXPIRY_DAYS = 14;
export const INVITE_DAILY_CAP = 20;
export const INVITE_RATE_WINDOW_SECS = 86_400; // 24h rolling for checkRateLimit

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Marker embedded in wallet_transaction.description so credits can be attributed per recruit. */
export const RECRUIT_TAG_PREFIX = 'recruit:';

export function inviteExpiresAt(createdAt, now = new Date()) {
  const start = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(start.getTime())) return new Date(now);
  return new Date(start.getTime() + INVITE_EXPIRY_DAYS * MS_PER_DAY);
}

export function isInviteExpired(invite, now = new Date()) {
  if (!invite || invite.status !== 'pending') return false;
  const expires = inviteExpiresAt(invite.created_at, now);
  return now.getTime() >= expires.getTime();
}

/**
 * Effective status for UI/API: pending | accepted | declined | expired.
 * Expired is computed (not stored) for pending invites past the TTL.
 */
export function effectiveInviteStatus(invite, now = new Date()) {
  if (!invite) return null;
  if (invite.status === 'pending' && isInviteExpired(invite, now)) return 'expired';
  return invite.status;
}

/** Recruiter may resend when invite is declined or expired (not accepted / still-fresh pending). */
export function canResendInvite(invite, now = new Date()) {
  const status = effectiveInviteStatus(invite, now);
  return status === 'declined' || status === 'expired';
}

/** Parse `… recruit:123` from a referral wallet description. */
export function parseRecruitIdFromDescription(description) {
  if (!description || typeof description !== 'string') return null;
  const m = description.match(/(?:^|[\s·|])recruit:(\d+)\b/i);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function buildRecruitShareDescription(orderType, recruitedUserId) {
  const base = `Affiliate share from ${orderType} order`;
  const id = Number(recruitedUserId);
  if (!Number.isInteger(id) || id <= 0) return base;
  return `${base} · ${RECRUIT_TAG_PREFIX}${id}`;
}

/**
 * Sum referral credits by recruited user_id (from tagged descriptions).
 * Untagged historical rows contribute to `unattributed`.
 */
export function sumEarningsByRecruit(transactions = []) {
  const byRecruit = new Map();
  let unattributed = 0;
  for (const t of transactions) {
    const amt = Number(t?.amount || 0);
    if (!Number.isFinite(amt)) continue;
    const recruitId = parseRecruitIdFromDescription(t.description);
    if (recruitId == null) {
      unattributed += amt;
      continue;
    }
    byRecruit.set(recruitId, (byRecruit.get(recruitId) || 0) + amt);
  }
  return { byRecruit, unattributed };
}

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Shape one recruit row for GET /referral/my-recruits.
 * @param {object} link — shared_ref_code row (+ recruit user + optional checkouts)
 * @param {Map<number,number>} earningsByRecruit
 * @param {Date|null} periodStart — if set, `in_period` is linked_at >= periodStart
 */
export function buildMyRecruitRow(link, earningsByRecruit = new Map(), periodStart = null) {
  const recruit = link?.user_shared_ref_code_shared_toTouser || link?.recruit || null;
  const recruitId = recruit?.user_id ?? link?.shared_to ?? null;
  const linkedAt = link?.created_at ? new Date(link.created_at) : null;
  const checkouts = Array.isArray(link?.checkouts) ? link.checkouts : [];
  const gmv = round2(checkouts.reduce((s, c) => s + Number(c?.total || 0), 0));
  const earnings = recruitId != null ? round2(earningsByRecruit.get(Number(recruitId)) || 0) : 0;
  const inPeriod = periodStart && linkedAt
    ? linkedAt.getTime() >= periodStart.getTime()
    : true;

  return {
    share_id: link?.share_id ?? null,
    linked_at: linkedAt ? linkedAt.toISOString() : null,
    in_period: !!inPeriod,
    user: recruit
      ? {
          user_id: recruit.user_id,
          username: recruit.username ?? null,
          name: recruit.name ?? null,
        }
      : null,
    lifetime_gmv: gmv,
    earnings_attributed: earnings,
  };
}

/**
 * @param {'all'|'period'|'active'} filter
 * — all: every recruit
 * — period: linked during the analytics window
 * — active: same as all for Phase 1 (all links are ongoing; reserved for future churn)
 */
export function filterMyRecruits(rows, filter = 'all') {
  const f = String(filter || 'all').toLowerCase();
  if (f === 'period') return rows.filter((r) => r.in_period);
  // active === all for now (one-recruiter-forever links have no inactive state yet)
  return rows;
}

export function invitePublicView(inv, side, now = new Date()) {
  const other = side === 'received' ? inv.recruiter : inv.invited;
  const status = effectiveInviteStatus(inv, now);
  const expiresAt = inviteExpiresAt(inv.created_at, now);
  return {
    invite_id: inv.invite_id,
    status,
    ref_code: inv.ref_code,
    created_at: inv.created_at,
    responded_at: inv.responded_at,
    expires_at: expiresAt.toISOString(),
    can_resend: side === 'sent' ? canResendInvite(inv, now) : false,
    user: other ? { user_id: other.user_id, username: other.username, name: other.name } : null,
  };
}
