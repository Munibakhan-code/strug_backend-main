import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { resolveRangeParam, resolveRange, RANGE_DAYS, buildEarningsSeries, round2 } from '../utils/analytics-buckets.js';
import {
  INVITE_DAILY_CAP,
  INVITE_RATE_WINDOW_SECS,
  buildMyRecruitRow,
  canResendInvite,
  filterMyRecruits,
  invitePublicView,
  isInviteExpired,
  round2 as r2,
  sumEarningsByRecruit,
} from '../utils/recruit-visibility.js';
import { RECRUIT_WALLET_SOURCE_FILTER } from '../utils/recruiter-share.js';
import { REFERRAL_TXN_WALLET_SOURCE } from '../utils/referral-settlement.js';
import { checkRateLimit } from '../utils/rate-limiter.js';
import notify from '../services/notify.js';

const router = express.Router();

function sumTxAmounts(rows) {
  return rows.reduce((sum, t) => sum + Number(t.amount || 0), 0);
}

/**
 * GET /referral/validate-code?code=
 * Checkout-safe lookup: confirms a friend code / username exists without creating a Recruit link.
 * Used by hotel/tempstay Apply before bindCheckoutReferralCode.
 */
router.get('/validate-code', authenticateToken, async (req, res) => {
  try {
    const typed = String(req.query.code || req.query.ref_code || '').trim();
    if (!typed) {
      return res.status(400).json({ successful: false, message: 'Enter a referral code' });
    }

    let codeOwner = await prisma.user.findFirst({
      where: { ref_code: { equals: typed, mode: 'insensitive' } },
      select: { user_id: true, ref_code: true, username: true },
    });
    if (!codeOwner) {
      const byUsername = await prisma.user.findFirst({
        where: { username: { equals: typed, mode: 'insensitive' } },
        select: { user_id: true, ref_code: true, username: true },
      });
      if (byUsername?.ref_code) codeOwner = byUsername;
    }
    if (!codeOwner?.ref_code) {
      return res.status(404).json({ successful: false, message: 'Invalid referral code' });
    }
    if (codeOwner.user_id === req.user.user_id) {
      return res.status(400).json({ successful: false, message: 'Cannot apply your own referral code' });
    }

    return res.json({
      successful: true,
      data: {
        valid: true,
        ref_code: codeOwner.ref_code,
      },
    });
  } catch (err) {
    console.error('Referral validate-code error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * POST /referral/apply
 * Apply a referral code. Each code is single-use.
 */
router.post('/apply', authenticateToken, async (req, res) => {
  try {
    const { ref_code } = req.body;
    if (!ref_code) return res.status(400).json({ successful: false, message: 'ref_code is required' });

    // Try to find code owner by ref_code; if not found, try username lookup.
    // Match case-insensitively: ref codes are stored uppercase (STRUG-…) but the client
    // sends a lowercased/trimmed value, so a case-sensitive equality never matched —
    // the code resolved to 404, was never persisted, and "disappeared" on refresh. (bug #57)
    const typed = String(ref_code).trim();
    let codeOwner = await prisma.user.findFirst({ where: { ref_code: { equals: typed, mode: 'insensitive' } } });
    if (!codeOwner) {
      const byUsername = await prisma.user.findFirst({ where: { username: { equals: typed, mode: 'insensitive' } }, select: { user_id: true, ref_code: true } });
      if (byUsername && byUsername.ref_code) codeOwner = byUsername;
    }
    if (!codeOwner) return res.status(404).json({ successful: false, message: 'Invalid referral code' });

    const resolvedCode = codeOwner.ref_code;

    // Cannot use own code
    if (codeOwner.user_id === req.user.user_id)
      return res.status(400).json({ successful: false, message: 'Cannot apply your own referral code' });

    // One recruiter per user: a user can only be recruited by ONE person, ever. This keeps the
    // recruiter revenue-share unambiguous (exactly one recruiter earns on this user's activity)
    // and matches the "another person cannot recruit that user" rule. We block applying ANY code
    // once the user already has a recruiter link — not just re-applying the same code.
    const existingLink = await prisma.shared_ref_code.findFirst({
      where: { shared_to: req.user.user_id },
    });
    if (existingLink) {
      const sameCode = existingLink.ref_code === resolvedCode;
      return res.status(409).json({
        successful: false,
        message: sameCode
          ? 'You have already applied this referral code'
          : 'You already have an affiliate and cannot be linked by someone else',
      });
    }

    await prisma.shared_ref_code.create({ data: { ref_code: resolvedCode, shared_to: req.user.user_id } });

    return res.status(201).json({ successful: true, message: 'Referral code applied successfully' });
  } catch (err) {
    console.error('Referral apply error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * GET /referral/my
 * Return all referral codes the authenticated user has applied (from friends).
 */
router.get('/my', authenticateToken, async (req, res) => {
  try {
    const applied = await prisma.shared_ref_code.findMany({
      where: { shared_to: req.user.user_id },
      orderBy: { share_id: 'desc' },
      select: { ref_code: true, share_id: true },
    });
    return res.json({ successful: true, data: { applied_codes: applied.map(r => r.ref_code) } });
  } catch (err) {
    console.error('Referral my error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * GET /referral/my-code
 * Return the authenticated user's referral code and how many times it has been used.
 */
router.get('/my-code', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { user_id: req.user.user_id },
      select: { ref_code: true },
    });
    if (!user) return res.status(404).json({ successful: false, message: 'User not found' });

    const usageCount = await prisma.shared_ref_code.count({
      where: { ref_code: user.ref_code },
    });

    return res.json({ successful: true, data: { ref_code: user.ref_code, usage_count: usageCount } });
  } catch (err) {
    console.error('Referral my-code error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * GET /referral/earnings
 * Return Invite & Earn (Recruit) wallet rows for the authenticated user.
 * Also returns Friend Referral (`source:'referral_txn'`) under `engines` so Wallet
 * can show the two programs distinctly without ledger conflict.
 *
 * Backward compatible: top-level `total` / `transactions` remain Recruit-only.
 */
router.get('/earnings', authenticateToken, async (req, res) => {
  try {
    const user_id = req.user.user_id;
    const [recruitTx, referralTx] = await Promise.all([
      prisma.wallet_transaction.findMany({
        where: { user_id, source: RECRUIT_WALLET_SOURCE_FILTER },
        orderBy: { created_at: 'desc' },
      }),
      prisma.wallet_transaction.findMany({
        where: { user_id, source: REFERRAL_TXN_WALLET_SOURCE },
        orderBy: { created_at: 'desc' },
      }),
    ]);

    const recruitTotal = sumTxAmounts(recruitTx);
    const referralTotal = sumTxAmounts(referralTx);

    return res.json({
      successful: true,
      data: {
        total: recruitTotal.toFixed(2),
        transactions: recruitTx,
        engines: {
          recruit: { total: recruitTotal.toFixed(2), transactions: recruitTx },
          referral: { total: referralTotal.toFixed(2), transactions: referralTx },
        },
      },
    });
  } catch (err) {
    console.error('Referral earnings error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * GET /referral/analytics/overview?range=7d|28d|90d|365d|lifetime
 *
 * Referral earnings tracker (#281). Extends the flat /earnings list with a range-aware
 * overview: lifetime + this-period totals with a prev-period delta, a daily earnings
 * trend, cleared-vs-pending split (wallet_transaction.status), and how many users have
 * All Recruit wallet_transactions use source in ('recruit','referral'); Friend Referral uses 'referral_txn'.
 */
router.get('/analytics/overview', authenticateToken, async (req, res) => {
  try {
    const user_id = req.user.user_id;
    const rangeParam = resolveRangeParam(req.query.range);
    const days = RANGE_DAYS[rangeParam];
    const { start, prevStart, prevEnd } = resolveRange(days);

    const me = await prisma.user.findUnique({ where: { user_id }, select: { ref_code: true } });

    const [rangeTx, prevTx, allTx, referredUsers] = await Promise.all([
      prisma.wallet_transaction.findMany({ where: { user_id, source: RECRUIT_WALLET_SOURCE_FILTER, created_at: { gte: start } }, select: { amount: true, status: true, created_at: true } }),
      prisma.wallet_transaction.findMany({ where: { user_id, source: RECRUIT_WALLET_SOURCE_FILTER, created_at: { gte: prevStart, lte: prevEnd } }, select: { amount: true } }),
      prisma.wallet_transaction.findMany({ where: { user_id, source: RECRUIT_WALLET_SOURCE_FILTER }, select: { amount: true, status: true } }),
      me?.ref_code ? prisma.shared_ref_code.count({ where: { ref_code: me.ref_code } }) : Promise.resolve(0),
    ]);

    const amt = t => Number(t.amount || 0);
    const { timeseries, summary } = buildEarningsSeries({ rows: rangeTx, prevRows: prevTx, dateField: 'created_at', gross: amt, net: amt, start, days });
    const lifetime_total = round2(allTx.reduce((s, t) => s + amt(t), 0));
    const cleared_total = round2(allTx.filter(t => t.status === 'completed').reduce((s, t) => s + amt(t), 0));
    const pending_total = round2(allTx.filter(t => t.status !== 'completed').reduce((s, t) => s + amt(t), 0));

    return res.json({
      successful: true,
      data: {
        range: rangeParam,
        currency: 'CAD',
        summary: {
          lifetime_total,
          period_total: summary.net,
          period_change_pct: summary.net_change_pct,
          referred_users: referredUsers,
          payouts_count: allTx.length,
          cleared_total,
          pending_total,
        },
        timeseries,
      },
    });
  } catch (err) {
    console.error('Referral analytics error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * GET /referral/wallet-balance
 * Return the authenticated user's real strug_wallet balance.
 */
router.get('/wallet-balance', authenticateToken, async (req, res) => {
  try {
    let wallet = await prisma.strug_wallet.findUnique({ where: { user_id: req.user.user_id } });
    if (!wallet) {
      wallet = await prisma.strug_wallet.create({ data: { user_id: req.user.user_id, balance: 0, currency: 'CAD' } });
    }
    return res.json({ successful: true, balance: parseFloat(wallet.balance).toFixed(2) });
  } catch (err) {
    console.error('Wallet balance error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * GET /referral/wallet-transactions
 * The authenticated user's own strug_wallet ledger, newest first — source-agnostic
 * (rideshare payouts, work earnings, mechanic payouts, referral, etc. all share the
 * same wallet_transaction table), for Wallet-tab "Order History" UIs.
 */
router.get('/wallet-transactions', authenticateToken, async (req, res) => {
  try {
    const transactions = await prisma.wallet_transaction.findMany({
      where: { user_id: req.user.user_id },
      orderBy: { created_at: 'desc' },
      take: 50,
      select: {
        transaction_id: true,
        amount: true,
        type: true,
        source: true,
        status: true,
        description: true,
        created_at: true,
      },
    });
    return res.json({ successful: true, data: transactions });
  } catch (err) {
    console.error('Wallet transactions error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Recruiter-initiated invites (consent-preserving revenue-share)
//
// Recruiters can invite a user BY USERNAME, but no revenue-share forms until the
// invited user accepts. This gives the "add by username" UX (#487) without letting
// anyone skim a non-consenting user (the reason /apply is recruited-user-initiated).
// One invite row per (recruiter, invited) pair; re-inviting a declined pair resets it.
// ---------------------------------------------------------------------------

/**
 * GET /referral/my-recruits?filter=all|period|active&range=7d|28d|90d|365d|lifetime
 *
 * Multi-ongoing recruit list for the signed-in recruiter: safe public identity,
 * linked_at (shared_ref_code.created_at), lifetime GMV (checkouts on the link),
 * and earnings attributed from tagged referral wallet rows.
 */
router.get('/my-recruits', authenticateToken, async (req, res) => {
  try {
    const user_id = req.user.user_id;
    const filter = String(req.query.filter || 'all').toLowerCase();
    const rangeParam = resolveRangeParam(req.query.range);
    const days = RANGE_DAYS[rangeParam];
    const { start: periodStart } = resolveRange(days);

    const me = await prisma.user.findUnique({ where: { user_id }, select: { ref_code: true } });
    if (!me?.ref_code) {
      return res.json({
        successful: true,
        data: {
          filter,
          range: rangeParam,
          currency: 'CAD',
          recruits: [],
          summary: { total: 0, in_period: 0, unattributed_earnings: 0 },
        },
      });
    }

    const [links, referralTx] = await Promise.all([
      prisma.shared_ref_code.findMany({
        where: { ref_code: me.ref_code, shared_to: { not: null } },
        orderBy: [{ created_at: 'desc' }, { share_id: 'desc' }],
        include: {
          user_shared_ref_code_shared_toTouser: {
            select: { user_id: true, username: true, name: true },
          },
          checkouts: { select: { total: true } },
        },
      }),
      prisma.wallet_transaction.findMany({
        where: { user_id, source: RECRUIT_WALLET_SOURCE_FILTER },
        select: { amount: true, description: true },
      }),
    ]);

    const { byRecruit, unattributed } = sumEarningsByRecruit(referralTx);
    const rows = links.map((link) => buildMyRecruitRow(link, byRecruit, periodStart));
    const filtered = filterMyRecruits(rows, filter);

    return res.json({
      successful: true,
      data: {
        filter,
        range: rangeParam,
        currency: 'CAD',
        recruits: filtered,
        summary: {
          total: rows.length,
          in_period: rows.filter((r) => r.in_period).length,
          unattributed_earnings: r2(unattributed),
        },
      },
    });
  } catch (err) {
    console.error('Referral my-recruits error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

async function assertInviteDailyCap(recruiterId) {
  const limited = await checkRateLimit(
    `rl:recruit-invite:${recruiterId}`,
    INVITE_DAILY_CAP,
    INVITE_RATE_WINDOW_SECS,
  );
  return limited;
}

function sendRecruitInviteNotify(io, { targetUserId, recruiter, inviteId }) {
  notify(io, {
    userId: targetUserId,
    vertical: 'payments',
    type: 'recruit.invite',
    urgency: 'actionable',
    title: `${recruiter.name || recruiter.username || 'Someone'} wants you as their affiliate`,
    body: 'Accept to link up — they earn a small reward when you transact, at no extra cost to you.',
    entityType: 'recruit_invite',
    entityId: inviteId,
    actionUrl: 'recruiter',
  });
}

/**
 * POST /referral/invite  { username }
 * Recruiter invites a user by username → PENDING invite + actionable notification.
 * Rate-limited: INVITE_DAILY_CAP invites/resends per recruiter per 24h.
 */
router.post('/invite', authenticateToken, async (req, res) => {
  try {
    const recruiterId = req.user.user_id;
    const username = String(req.body?.username || '').trim();
    if (!username) return res.status(400).json({ successful: false, message: 'username is required' });

    if (await assertInviteDailyCap(recruiterId)) {
      return res.status(429).json({
        successful: false,
        message: `Invite limit reached — max ${INVITE_DAILY_CAP} invites per day`,
      });
    }

    const recruiter = await prisma.user.findUnique({
      where: { user_id: recruiterId },
      select: { ref_code: true, name: true, username: true },
    });
    if (!recruiter?.ref_code) return res.status(400).json({ successful: false, message: 'You do not have an Affiliate Code yet' });

    const target = await prisma.user.findFirst({
      where: { username: { equals: username, mode: 'insensitive' } },
      select: { user_id: true, username: true, name: true },
    });
    if (!target) return res.status(404).json({ successful: false, message: 'No user with that username' });
    if (target.user_id === recruiterId) return res.status(400).json({ successful: false, message: 'You cannot invite yourself' });

    // One recruiter per user: if the target already has a recruiter, they can't be invited.
    const existingLink = await prisma.shared_ref_code.findFirst({ where: { shared_to: target.user_id } });
    if (existingLink) return res.status(409).json({ successful: false, message: 'That user already has an affiliate' });

    // Block re-invite while a fresh pending invite already exists (use resend for expired/declined).
    const existingInvite = await prisma.recruit_invite.findUnique({
      where: { recruiter_user_id_invited_user_id: { recruiter_user_id: recruiterId, invited_user_id: target.user_id } },
    });
    if (existingInvite?.status === 'pending' && !isInviteExpired(existingInvite)) {
      return res.status(409).json({ successful: false, message: 'Invite already pending for that user' });
    }
    if (existingInvite?.status === 'accepted') {
      return res.status(409).json({ successful: false, message: 'That user already accepted your invite' });
    }

    // Upsert so re-inviting a previously-declined/expired user reopens the same row as pending.
    const invite = await prisma.recruit_invite.upsert({
      where: { recruiter_user_id_invited_user_id: { recruiter_user_id: recruiterId, invited_user_id: target.user_id } },
      update: { status: 'pending', ref_code: recruiter.ref_code, created_at: new Date(), responded_at: null },
      create: { recruiter_user_id: recruiterId, invited_user_id: target.user_id, ref_code: recruiter.ref_code, status: 'pending' },
    });

    sendRecruitInviteNotify(req.app.get('io'), {
      targetUserId: target.user_id,
      recruiter,
      inviteId: invite.invite_id,
    });

    return res.status(201).json({
      successful: true,
      message: 'Invite sent',
      invite: invitePublicView({ ...invite, invited: target }, 'sent'),
    });
  } catch (err) {
    console.error('Recruit invite error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * GET /referral/invites
 * PENDING (non-expired) invites RECEIVED by the authenticated user.
 */
router.get('/invites', authenticateToken, async (req, res) => {
  try {
    const now = new Date();
    const invites = await prisma.recruit_invite.findMany({
      where: { invited_user_id: req.user.user_id, status: 'pending' },
      include: { recruiter: { select: { user_id: true, username: true, name: true } } },
      orderBy: { created_at: 'desc' },
    });
    const actionable = invites
      .filter((i) => !isInviteExpired(i, now))
      .map((i) => invitePublicView(i, 'received', now));
    return res.json({ successful: true, invites: actionable });
  } catch (err) {
    console.error('Recruit invites list error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * GET /referral/sent-invites
 * Invites SENT by the authenticated user (as recruiter), any status (incl. computed expired).
 */
router.get('/sent-invites', authenticateToken, async (req, res) => {
  try {
    const now = new Date();
    const invites = await prisma.recruit_invite.findMany({
      where: { recruiter_user_id: req.user.user_id },
      include: { invited: { select: { user_id: true, username: true, name: true } } },
      orderBy: { created_at: 'desc' },
    });
    return res.json({ successful: true, invites: invites.map((i) => invitePublicView(i, 'sent', now)) });
  } catch (err) {
    console.error('Recruit sent-invites error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * POST /referral/invites/:id/resend
 * Recruiter reopens an expired/declined invite (same daily cap as /invite).
 */
router.post('/invites/:id/resend', authenticateToken, async (req, res) => {
  try {
    const recruiterId = req.user.user_id;
    const inviteId = Number(req.params.id);
    if (!Number.isInteger(inviteId)) return res.status(400).json({ successful: false, message: 'Invalid invite id' });

    if (await assertInviteDailyCap(recruiterId)) {
      return res.status(429).json({
        successful: false,
        message: `Invite limit reached — max ${INVITE_DAILY_CAP} invites per day`,
      });
    }

    const invite = await prisma.recruit_invite.findUnique({
      where: { invite_id: inviteId },
      include: { invited: { select: { user_id: true, username: true, name: true } } },
    });
    if (!invite || invite.recruiter_user_id !== recruiterId) {
      return res.status(404).json({ successful: false, message: 'Invite not found' });
    }
    if (!canResendInvite(invite)) {
      return res.status(409).json({
        successful: false,
        message: invite.status === 'accepted'
          ? 'Invite already accepted'
          : 'Invite is still pending — wait for a response or expiry before resending',
      });
    }

    const existingLink = await prisma.shared_ref_code.findFirst({ where: { shared_to: invite.invited_user_id } });
    if (existingLink) return res.status(409).json({ successful: false, message: 'That user already has an affiliate' });

    const recruiter = await prisma.user.findUnique({
      where: { user_id: recruiterId },
      select: { ref_code: true, name: true, username: true },
    });
    if (!recruiter?.ref_code) return res.status(400).json({ successful: false, message: 'You do not have an Affiliate Code yet' });

    const updated = await prisma.recruit_invite.update({
      where: { invite_id: inviteId },
      data: {
        status: 'pending',
        ref_code: recruiter.ref_code,
        created_at: new Date(),
        responded_at: null,
      },
      include: { invited: { select: { user_id: true, username: true, name: true } } },
    });

    sendRecruitInviteNotify(req.app.get('io'), {
      targetUserId: updated.invited_user_id,
      recruiter,
      inviteId: updated.invite_id,
    });

    return res.json({
      successful: true,
      message: 'Invite resent',
      invite: invitePublicView(updated, 'sent'),
    });
  } catch (err) {
    console.error('Recruit resend error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * POST /referral/invites/:id/accept
 * Invited user accepts → forms the shared_ref_code link and notifies the recruiter.
 */
router.post('/invites/:id/accept', authenticateToken, async (req, res) => {
  try {
    const inviteId = Number(req.params.id);
    if (!Number.isInteger(inviteId)) return res.status(400).json({ successful: false, message: 'Invalid invite id' });

    const invite = await prisma.recruit_invite.findUnique({ where: { invite_id: inviteId } });
    if (!invite || invite.invited_user_id !== req.user.user_id) return res.status(404).json({ successful: false, message: 'Invite not found' });
    if (invite.status !== 'pending') return res.status(409).json({ successful: false, message: `Invite already ${invite.status}` });
    if (isInviteExpired(invite)) {
      return res.status(410).json({
        successful: false,
        message: 'This invite has expired. Ask the affiliate to send a new one',
      });
    }

    // Re-check one-recruiter-per-user at accept time (they may have been recruited since the invite).
    const existingLink = await prisma.shared_ref_code.findFirst({ where: { shared_to: req.user.user_id } });
    if (existingLink) {
      await prisma.recruit_invite.update({ where: { invite_id: inviteId }, data: { status: 'declined', responded_at: new Date() } });
      return res.status(409).json({ successful: false, message: 'You already have an affiliate' });
    }

    await prisma.$transaction([
      prisma.shared_ref_code.create({ data: { ref_code: invite.ref_code, shared_to: req.user.user_id } }),
      prisma.recruit_invite.update({ where: { invite_id: inviteId }, data: { status: 'accepted', responded_at: new Date() } }),
      // Any other pending invites to this user are now moot — they have a recruiter.
      prisma.recruit_invite.updateMany({
        where: { invited_user_id: req.user.user_id, status: 'pending', invite_id: { not: inviteId } },
        data: { status: 'declined', responded_at: new Date() },
      }),
    ]);

    const me = await prisma.user.findUnique({ where: { user_id: req.user.user_id }, select: { username: true, name: true } });
    notify(req.app.get('io'), {
      userId: invite.recruiter_user_id,
      vertical: 'payments',
      type: 'recruit.accepted',
      urgency: 'ambient',
      title: `${me?.name || me?.username || 'Someone'} accepted your affiliate invite`,
      body: 'You now earn a reward when they transact on Strug.',
      entityType: 'recruit_invite',
      entityId: invite.invite_id,
      actionUrl: 'recruiter',
    });

    return res.json({ successful: true, message: 'Invite accepted' });
  } catch (err) {
    console.error('Recruit accept error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

/**
 * POST /referral/invites/:id/decline
 */
router.post('/invites/:id/decline', authenticateToken, async (req, res) => {
  try {
    const inviteId = Number(req.params.id);
    if (!Number.isInteger(inviteId)) return res.status(400).json({ successful: false, message: 'Invalid invite id' });
    const invite = await prisma.recruit_invite.findUnique({ where: { invite_id: inviteId } });
    if (!invite || invite.invited_user_id !== req.user.user_id) return res.status(404).json({ successful: false, message: 'Invite not found' });
    if (invite.status !== 'pending') return res.status(409).json({ successful: false, message: `Invite already ${invite.status}` });
    if (isInviteExpired(invite)) {
      return res.status(410).json({ successful: false, message: 'This invite has already expired' });
    }
    await prisma.recruit_invite.update({ where: { invite_id: inviteId }, data: { status: 'declined', responded_at: new Date() } });
    return res.json({ successful: true, message: 'Invite declined' });
  } catch (err) {
    console.error('Recruit decline error:', err);
    return res.status(500).json({ successful: false, message: 'Internal server error' });
  }
});

export default router;
