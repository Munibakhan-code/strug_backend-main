// routes/board-admin-kyc-routes.js
//
// Read-only KYC & Verification data for the internal dashboards (strug-internal-dashboards
// → KYC & Verification dashboard). RESTRICTED: gated by authenticateBoard + requireRestricted
// (the can_access_restricted tier, stricter than can_manage_members). Mounted at
// /board-admin/kyc. NO schema change beyond the board_member.can_access_restricted flag.
//
// What's real: the verification-BADGE system —
//   social_profile.verification_type (NONE / INDIVIDUAL / CORPORATION / GOVERNMENT / ...)
//   is_verified on social_profile / channel / live_streamer_profile
//   live_streamer_profile.stripe_account_id  → Stripe Connect payout-KYC onboarding state
//
// What genuinely does NOT exist (→ honest N/A in the dashboard): identity-document KYC,
// a verification-request / approval queue ("triggers"), AML / sanctions screening, document
// upload / review, per-vertical KYC flows. Payout identity verification is handled by Stripe
// Connect (external) — only the account-id presence is stored here.

import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateBoard, requireDashboard } from '../middleware/authenticate-board.js';
import { decrypt } from '../utils/crypto.js';

const router = express.Router();
router.use(authenticateBoard, requireDashboard('kyc', 'read'));

const num = (d) => (d == null ? 0 : Number(d));
const clampInt = (v, lo, hi, dflt) => {
  const n = parseInt(v);
  if (Number.isNaN(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};
const mapGroup = (rows, key) =>
  rows.map((r) => ({ name: r[key] == null ? '(none)' : String(r[key]), count: num(r._count?._all) }))
    .sort((a, b) => b.count - a.count);
const pick = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt);

const looksEncrypted = (v) => typeof v === 'string' && v.length >= 32 && v.length % 2 === 0 && /^[0-9a-f]+$/i.test(v);
const decryptEmail = (v) => { if (!looksEncrypted(v)) return v; try { return decrypt(v); } catch { return v; } };
async function userSummaries(ids) {
  const unique = [...new Set(ids.filter((x) => x != null))];
  if (!unique.length) return {};
  const users = await prisma.user.findMany({ where: { user_id: { in: unique } }, select: { user_id: true, name: true, username: true, email: true } });
  const map = {};
  for (const u of users) map[u.user_id] = { user_id: u.user_id, name: u.name, username: u.username, email: decryptEmail(u.email) };
  return map;
}

// GET /overview — verification-badge rollup + Connect payout-KYC posture.
router.get('/overview', async (req, res) => {
  try {
    const [
      socialTotal, socialVerified, byType,
      channelTotal, channelVerified,
      streamerTotal, streamerVerified, streamerConnect,
    ] = await Promise.all([
      prisma.social_profile.count(),
      prisma.social_profile.count({ where: { is_verified: true } }),
      prisma.social_profile.groupBy({ by: ['verification_type'], _count: { _all: true } }),
      prisma.channel.count(),
      prisma.channel.count({ where: { is_verified: true } }),
      prisma.live_streamer_profile.count(),
      prisma.live_streamer_profile.count({ where: { is_verified: true } }),
      prisma.live_streamer_profile.count({ where: { stripe_account_id: { not: null } } }),
    ]);
    res.json({
      social: { total: socialTotal, verified: socialVerified, byVerificationType: mapGroup(byType, 'verification_type') },
      channels: { total: channelTotal, verified: channelVerified },
      streamers: { total: streamerTotal, verified: streamerVerified, connectOnboarded: streamerConnect, connectMissing: streamerTotal - streamerConnect },
      totals: {
        verifiedBadges: socialVerified + channelVerified + streamerVerified,
        typedVerifications: byType.filter((t) => t.verification_type && t.verification_type !== 'NONE').reduce((a, b) => a + num(b._count._all), 0),
      },
      note: 'KYC & Verification = the platform\'s verification-BADGE system (verification_type + is_verified) plus Stripe Connect payout-KYC (stripe_account_id presence). Identity-document KYC, AML screening and a verification-approval queue have no store — Stripe handles payout identity externally.',
    });
  } catch (err) {
    console.error('[board-admin/kyc] /overview failed:', err);
    res.status(500).json({ error: 'Failed to load KYC overview' });
  }
});

// GET /verified — verification roster.  ?type=social|channel|streamer  ?verification_type=  ?verified=  ?page= ?limit=
router.get('/verified', async (req, res) => {
  try {
    const type = pick(req.query.type, ['social', 'channel', 'streamer'], 'social');
    const page = clampInt(req.query.page, 1, 100000, 1);
    const limit = clampInt(req.query.limit, 1, 100, 25);
    const skip = (page - 1) * limit;
    const verified = req.query.verified === 'true' ? true : req.query.verified === 'false' ? false : undefined;

    if (type === 'social') {
      const where = {};
      if (verified !== undefined) where.is_verified = verified;
      if (req.query.verification_type) where.verification_type = String(req.query.verification_type);
      const [total, rows] = await Promise.all([
        prisma.social_profile.count({ where }),
        prisma.social_profile.findMany({
          where, orderBy: { profile_id: 'desc' }, skip, take: limit,
          select: { profile_id: true, user_id: true, handle: true, display_name: true, is_verified: true, verification_type: true, created_at: true },
        }),
      ]);
      const users = await userSummaries(rows.map((r) => r.user_id));
      return res.json({
        type, total, pagination: { page, limit, pages: Math.ceil(total / limit) },
        filters: { verified: req.query.verified || null, verification_type: req.query.verification_type || null },
        profiles: rows.map((p) => ({ id: p.profile_id, handle: p.handle, display_name: p.display_name, is_verified: p.is_verified, verification_type: p.verification_type, created_at: p.created_at, owner: users[p.user_id] || { user_id: p.user_id } })),
        note: 'Social verification roster — profiles by verification badge (verification_type) and is_verified flag.',
      });
    }

    const model = type === 'channel' ? prisma.channel : prisma.live_streamer_profile;
    const idKey = type === 'channel' ? 'channel_id' : 'streamer_id';
    const where = {};
    if (verified !== undefined) where.is_verified = verified;
    const sel = type === 'channel'
      ? { channel_id: true, user_id: true, handle: true, display_name: true, is_verified: true, created_at: true }
      : { streamer_id: true, user_id: true, handle: true, display_name: true, is_verified: true, monetization_status: true, stripe_account_id: true, created_at: true };
    const [total, rows] = await Promise.all([
      model.count({ where }),
      model.findMany({ where, orderBy: { [idKey]: 'desc' }, skip, take: limit, select: sel }),
    ]);
    const users = await userSummaries(rows.map((r) => r.user_id));
    return res.json({
      type, total, pagination: { page, limit, pages: Math.ceil(total / limit) },
      filters: { verified: req.query.verified || null },
      profiles: rows.map((p) => ({
        id: p[idKey], handle: p.handle, display_name: p.display_name, is_verified: p.is_verified,
        monetization_status: p.monetization_status ?? null, connect: p.stripe_account_id != null,
        created_at: p.created_at, owner: users[p.user_id] || { user_id: p.user_id },
      })),
      note: `${type === 'channel' ? 'Channel' : 'Streamer'} verification roster — verified badge${type === 'streamer' ? ' + Connect payout-KYC posture' : ''}.`,
    });
  } catch (err) {
    console.error('[board-admin/kyc] /verified failed:', err);
    res.status(500).json({ error: 'Failed to load verification roster' });
  }
});

// GET /connect — Stripe Connect payout-KYC posture across streamers.  ?onboarded=true|false ?page= ?limit=
router.get('/connect', async (req, res) => {
  try {
    const page = clampInt(req.query.page, 1, 100000, 1);
    const limit = clampInt(req.query.limit, 1, 100, 25);
    const skip = (page - 1) * limit;
    const onboarded = req.query.onboarded === 'true' ? true : req.query.onboarded === 'false' ? false : undefined;
    const where = onboarded === true ? { stripe_account_id: { not: null } } : onboarded === false ? { stripe_account_id: null } : {};

    const [total, onboardedCount, missingCount, rows] = await Promise.all([
      prisma.live_streamer_profile.count({ where }),
      prisma.live_streamer_profile.count({ where: { stripe_account_id: { not: null } } }),
      prisma.live_streamer_profile.count({ where: { stripe_account_id: null } }),
      prisma.live_streamer_profile.findMany({
        where, orderBy: { streamer_id: 'desc' }, skip, take: limit,
        select: { streamer_id: true, user_id: true, handle: true, display_name: true, monetization_status: true, stripe_account_id: true, is_verified: true },
      }),
    ]);
    const users = await userSummaries(rows.map((r) => r.user_id));
    res.json({
      summary: { onboarded: onboardedCount, missing: missingCount, total: onboardedCount + missingCount },
      total, pagination: { page, limit, pages: Math.ceil(total / limit) },
      filters: { onboarded: req.query.onboarded || null },
      streamers: rows.map((s) => ({
        id: s.streamer_id, handle: s.handle, display_name: s.display_name, is_verified: s.is_verified,
        monetization_status: s.monetization_status, connect: s.stripe_account_id != null,
        owner: users[s.user_id] || { user_id: s.user_id },
      })),
      note: 'Connect payout-KYC = whether a streamer has completed Stripe Connect onboarding (stripe_account_id present). Full identity-verification state (payouts_enabled / details_submitted) lives in Stripe and is checked live at payout time, not stored here.',
    });
  } catch (err) {
    console.error('[board-admin/kyc] /connect failed:', err);
    res.status(500).json({ error: 'Failed to load Connect KYC' });
  }
});

export default router;
