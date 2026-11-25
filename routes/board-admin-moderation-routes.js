// routes/board-admin-moderation-routes.js
//
// Read-only Content Moderation (Trust & Safety) data for the internal dashboards
// (strug-internal-dashboards → Content Moderation dashboard). Gated by the board
// identity + can_manage_members (the admin tier — these views expose reporter /
// appellant identity + emails), matching Finance / Operations / Vertical Management /
// Customer Support / Analytics / Product / Communications. Mounted at
// /board-admin/moderation. Reads + a small set of enforcement WRITES (see the bottom
// of this file): report triage, appeal decisions, profile shadow-ban.
//
// The moderation dashboard is a triage view over the platform's real trust-&-safety
// signals. It used to be read-only, which meant staff could see the entire queue and
// action none of it: the app-side equivalents (/social-moderation/admin/*) are gated on
// the APP-user admin identity, and the dashboard holds a BOARD token, so they were
// unreachable from here. Board-authed enforcement writes now live at the bottom of this
// file. Post-level actions (ban/sensitive/pin/restrict) already existed board-authed
// under /board-admin/townhall/*; account status stays at /board-admin/users/:id/status.
//
// The real stores it surfaces:
//   social_report      user-reported POST / COMMENT / PROFILE / AD, pending→resolved
//                      (the Communications /moderation view shows a thin summary of this;
//                       this router is the full queue with reporter identity + filters).
//   content_appeal     appeals against moderation actions (POST / COMMENT / PROFILE).
//   video (safety cols) is_nsfw / is_sensitive / moderation_flag / safety_status /
//                      safety_score / status='banned' — denormalized safety flags the
//                      transcode + content-safety pipeline writes back per video.
//   social_audit_log   the moderation action log (shadow_ban, appeal decisions, …).
//   user.account_status suspended / banned / restricted populations (enforcement).
//   social_profile     is_shadow_banned / is_banned profile sanctions.
//   ads_campaign       PENDING_REVIEW + content-safety-flagged ad creatives.
//
// What genuinely does NOT exist (→ honest N/A in the dashboard): a rule / policy /
// keyword-filter / ML-classifier / auto-action store; a moderator workforce /
// assignment / SLA / shift store; a transparency-report / regulatory (DSA) store.

import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateBoard, requireDashboard } from '../middleware/authenticate-board.js';
import { decrypt } from '../utils/crypto.js';

const router = express.Router();
router.use(authenticateBoard, requireDashboard('content-moderation', 'read'));

const num = (d) => (d == null ? 0 : Number(d));
const clampInt = (v, lo, hi, dflt) => {
  const n = parseInt(v);
  if (Number.isNaN(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};
const mapGroup = (rows, key) =>
  rows
    .map((r) => ({ name: r[key] == null ? '(none)' : String(r[key]), count: num(r._count?._all) }))
    .sort((a, b) => b.count - a.count);
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

// user.email is encrypted at rest (deterministic AES); this board endpoint is
// authorized to display it. Only decrypt hex-looking ciphertext.
const looksEncrypted = (v) => typeof v === 'string' && v.length >= 32 && v.length % 2 === 0 && /^[0-9a-f]+$/i.test(v);
const decryptEmail = (v) => {
  if (!looksEncrypted(v)) return v;
  try { return decrypt(v); } catch { return v; }
};

// Resolve social_profile ids → a small identity summary (reporter / appellant / target).
async function profileSummaries(profileIds) {
  const unique = [...new Set(profileIds.filter((x) => x != null))];
  if (!unique.length) return {};
  const profiles = await prisma.social_profile.findMany({
    where: { profile_id: { in: unique } },
    select: {
      profile_id: true, display_name: true, handle: true, user_id: true,
      user: { select: { name: true, username: true, email: true } },
    },
  });
  const map = {};
  for (const p of profiles) {
    map[p.profile_id] = {
      profile_id: p.profile_id,
      user_id: p.user_id,
      display_name: p.display_name,
      handle: p.handle,
      name: p.user?.name || null,
      username: p.user?.username || null,
      email: decryptEmail(p.user?.email),
    };
  }
  return map;
}

// A report/appeal is "open" while pending; resolved/dismissed/reviewed/approved/rejected
// are terminal. We bucket for consistent StatRails across views.
const isOpen = (status) => status === 'pending';

// ─────────────────────────────────────────────────────────────────────────────────────
// GET /overview — the moderation HOME rollup across every signal.
// ─────────────────────────────────────────────────────────────────────────────────────
router.get('/overview', async (_req, res) => {
  try {
    const [
      reportTotal, reportPending, reportByStatus, reportByTarget,
      appealTotal, appealPending, appealByStatus,
      nsfwCount, sensitiveVideo, flaggedVideo, bannedVideo, pendingSafety,
      suspended, banned, restricted, shadowProfiles, bannedProfiles,
      adPending, adFlagged,
      auditRecent, reportsRecent,
    ] = await Promise.all([
      prisma.social_report.count(),
      prisma.social_report.count({ where: { status: 'pending' } }),
      prisma.social_report.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.social_report.groupBy({ by: ['target_type'], _count: { _all: true } }),
      prisma.content_appeal.count(),
      prisma.content_appeal.count({ where: { status: 'pending' } }),
      prisma.content_appeal.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.video.count({ where: { is_nsfw: true } }),
      prisma.video.count({ where: { is_sensitive: true } }),
      prisma.video.count({ where: { moderation_flag: { not: null } } }),
      prisma.video.count({ where: { status: 'banned' } }),
      prisma.video.count({ where: { safety_status: 'pending' } }),
      prisma.user.count({ where: { account_status: 'suspended' } }),
      prisma.user.count({ where: { account_status: 'banned' } }),
      prisma.user.count({ where: { account_status: 'restricted' } }),
      prisma.social_profile.count({ where: { is_shadow_banned: true } }),
      prisma.social_profile.count({ where: { is_banned: true } }),
      prisma.ads_campaign.count({ where: { status: 'PENDING_REVIEW' } }),
      prisma.ads_campaign.count({ where: { OR: [{ is_sensitive: true }, { safety_score: { lt: 1 } }] } }),
      prisma.social_audit_log.findMany({ orderBy: { created_at: 'desc' }, take: 12 }),
      prisma.social_report.findMany({ orderBy: { created_at: 'desc' }, take: 12 }),
    ]);

    // 30-day daily report volume.
    const daily = await prisma.$queryRaw`
      SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS count
      FROM social_report
      WHERE created_at >= ${daysAgo(30)}
      GROUP BY 1 ORDER BY 1 ASC`;

    // Merge a light activity feed (audit actions + new reports), newest first.
    const feed = [
      ...auditRecent.map((a) => ({ kind: 'action', id: a.log_id, label: a.action, detail: a.description, at: a.created_at })),
      ...reportsRecent.map((r) => ({ kind: 'report', id: r.report_id, label: `report · ${r.target_type}`, detail: r.reason, at: r.created_at })),
    ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 16);

    res.json({
      reports: {
        total: reportTotal, pending: reportPending,
        byStatus: mapGroup(reportByStatus, 'status'),
        byTargetType: mapGroup(reportByTarget, 'target_type'),
      },
      appeals: {
        total: appealTotal, pending: appealPending,
        byStatus: mapGroup(appealByStatus, 'status'),
      },
      video: {
        nsfw: nsfwCount, sensitive: sensitiveVideo, flagged: flaggedVideo,
        banned: bannedVideo, pendingSafety,
      },
      enforcement: {
        suspended, banned, restricted,
        shadowBannedProfiles: shadowProfiles, bannedProfiles,
      },
      ads: { pendingReview: adPending, flagged: adFlagged },
      daily: daily.map((d) => ({ day: d.day, count: num(d.count) })),
      feed,
      note: 'Moderation overview = a read-only rollup across the platform trust-&-safety stores (content reports, appeals, video safety flags, enforcement populations, ad review, action log). Write actions live in the app admin endpoints.',
    });
  } catch (err) {
    console.error('[board-admin/moderation] /overview failed:', err);
    res.status(500).json({ error: 'Failed to load moderation overview' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────
// GET /reports — the workhorse: social_report feed with reporter identity + filters.
//   ?status=pending|reviewed|resolved|dismissed  ?target_type=POST|COMMENT|PROFILE|AD
//   ?search=<reason ILIKE>  ?days=N  ?page=&limit=
// ─────────────────────────────────────────────────────────────────────────────────────
router.get('/reports', async (req, res) => {
  try {
    const page = clampInt(req.query.page, 1, 100000, 1);
    const limit = clampInt(req.query.limit, 1, 100, 25);
    const where = {};
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.target_type) where.target_type = String(req.query.target_type);
    if (req.query.days) where.created_at = { gte: daysAgo(clampInt(req.query.days, 1, 365, 30)) };
    if (req.query.search) where.reason = { contains: String(req.query.search), mode: 'insensitive' };

    const [total, rows, byStatus, byTarget] = await Promise.all([
      prisma.social_report.count({ where }),
      prisma.social_report.findMany({
        where, orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit, take: limit,
      }),
      prisma.social_report.groupBy({ by: ['status'], _count: { _all: true }, where }),
      prisma.social_report.groupBy({ by: ['target_type'], _count: { _all: true }, where }),
    ]);

    const reporters = await profileSummaries(rows.map((r) => r.reporter_id));
    res.json({
      total,
      pagination: { page, limit, pages: Math.ceil(total / limit) },
      byStatus: mapGroup(byStatus, 'status'),
      byTargetType: mapGroup(byTarget, 'target_type'),
      filters: {
        status: req.query.status || null, target_type: req.query.target_type || null,
        search: req.query.search || null,
      },
      reports: rows.map((r) => ({
        report_id: r.report_id, target_type: r.target_type, target_id: r.target_id,
        reason: r.reason, status: r.status, open: isOpen(r.status),
        created_at: r.created_at, updated_at: r.updated_at,
        reporter: reporters[r.reporter_id] || null,
      })),
    });
  } catch (err) {
    console.error('[board-admin/moderation] /reports failed:', err);
    res.status(500).json({ error: 'Failed to load reports' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────
// GET /appeals — content_appeal feed (appeals against moderation actions).
//   ?status=pending|approved|rejected  ?page=&limit=
// ─────────────────────────────────────────────────────────────────────────────────────
router.get('/appeals', async (req, res) => {
  try {
    const page = clampInt(req.query.page, 1, 100000, 1);
    const limit = clampInt(req.query.limit, 1, 100, 25);
    const where = {};
    if (req.query.status) where.status = String(req.query.status);

    const [total, rows, byStatus, byTarget] = await Promise.all([
      prisma.content_appeal.count({ where }),
      prisma.content_appeal.findMany({
        where, orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit, take: limit,
      }),
      prisma.content_appeal.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.content_appeal.groupBy({ by: ['target_type'], _count: { _all: true } }),
    ]);

    const appellants = await profileSummaries(rows.map((r) => r.profile_id));
    res.json({
      total,
      pagination: { page, limit, pages: Math.ceil(total / limit) },
      byStatus: mapGroup(byStatus, 'status'),
      byTargetType: mapGroup(byTarget, 'target_type'),
      filters: { status: req.query.status || null },
      appeals: rows.map((a) => ({
        appeal_id: a.appeal_id, target_type: a.target_type, target_id: a.target_id,
        reason: a.reason, status: a.status, open: isOpen(a.status), created_at: a.created_at,
        appellant: appellants[a.profile_id] || null,
      })),
      note: 'Appeals = the content_appeal store (a user contesting a moderation action on their POST / COMMENT / PROFILE). The resolve action (approve / reject) is a write in the app admin endpoint — this view is read-only.',
    });
  } catch (err) {
    console.error('[board-admin/moderation] /appeals failed:', err);
    res.status(500).json({ error: 'Failed to load appeals' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────
// GET /video-safety — the video table's denormalized safety flags.
//   ?mode=nsfw|sensitive|review|banned|scores  ?page=&limit=
//   nsfw     → is_nsfw = true
//   sensitive→ is_sensitive = true
//   review   → safety_status = 'pending' OR moderation_flag IS NOT NULL
//   banned   → status = 'banned'
//   scores   → lowest safety_score first (riskiest)
// ─────────────────────────────────────────────────────────────────────────────────────
router.get('/video-safety', async (req, res) => {
  try {
    const mode = ['nsfw', 'sensitive', 'review', 'banned', 'scores'].includes(req.query.mode) ? req.query.mode : 'nsfw';
    const page = clampInt(req.query.page, 1, 100000, 1);
    const limit = clampInt(req.query.limit, 1, 100, 25);

    let where = {};
    let orderBy = { created_at: 'desc' };
    if (mode === 'nsfw') where = { is_nsfw: true };
    else if (mode === 'sensitive') where = { is_sensitive: true };
    else if (mode === 'review') where = { OR: [{ safety_status: 'pending' }, { moderation_flag: { not: null } }] };
    else if (mode === 'banned') where = { status: 'banned' };
    else if (mode === 'scores') { where = {}; orderBy = { safety_score: 'asc' }; }

    // Summary counts across every mode, independent of the current filter.
    const [nsfw, sensitive, review, banned, total, rows] = await Promise.all([
      prisma.video.count({ where: { is_nsfw: true } }),
      prisma.video.count({ where: { is_sensitive: true } }),
      prisma.video.count({ where: { OR: [{ safety_status: 'pending' }, { moderation_flag: { not: null } }] } }),
      prisma.video.count({ where: { status: 'banned' } }),
      prisma.video.count({ where }),
      prisma.video.findMany({
        where, orderBy, skip: (page - 1) * limit, take: limit,
        select: {
          video_id: true, public_id: true, title: true, status: true,
          is_nsfw: true, is_sensitive: true, safety_status: true, safety_score: true,
          moderation_flag: true, processing_status: true, created_at: true,
          channel: { select: { display_name: true, handle: true, user_id: true } },
        },
      }),
    ]);

    res.json({
      mode,
      summary: { nsfw, sensitive, review, banned },
      total,
      pagination: { page, limit, pages: Math.ceil(total / limit) },
      videos: rows.map((v) => ({
        video_id: v.video_id, public_id: v.public_id, title: v.title, status: v.status,
        is_nsfw: v.is_nsfw, is_sensitive: v.is_sensitive, safety_status: v.safety_status,
        safety_score: v.safety_score, moderation_flag: v.moderation_flag,
        processing_status: v.processing_status, created_at: v.created_at,
        channel: v.channel ? { display_name: v.channel.display_name, handle: v.channel.handle, user_id: v.channel.user_id } : null,
      })),
      note: 'Video safety = the flags the transcode + content-safety pipeline writes onto each video (is_nsfw / is_sensitive / safety_score / moderation_flag / safety_status). Advisory markers — there is no per-video admin action store, so this is a review surface, not a queue with write actions.',
    });
  } catch (err) {
    console.error('[board-admin/moderation] /video-safety failed:', err);
    res.status(500).json({ error: 'Failed to load video safety' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────
// GET /enforcement — the sanction populations.
//   ?mode=suspended|banned|restricted   → user.account_status populations
//   ?mode=shadow|banned-profiles        → social_profile sanctions
//   ?page=&limit=
// ─────────────────────────────────────────────────────────────────────────────────────
router.get('/enforcement', async (req, res) => {
  try {
    const mode = ['suspended', 'banned', 'restricted', 'shadow', 'banned-profiles'].includes(req.query.mode) ? req.query.mode : 'suspended';
    const page = clampInt(req.query.page, 1, 100000, 1);
    const limit = clampInt(req.query.limit, 1, 100, 25);

    const [suspended, banned, restricted, shadowProfiles, bannedProfiles] = await Promise.all([
      prisma.user.count({ where: { account_status: 'suspended' } }),
      prisma.user.count({ where: { account_status: 'banned' } }),
      prisma.user.count({ where: { account_status: 'restricted' } }),
      prisma.social_profile.count({ where: { is_shadow_banned: true } }),
      prisma.social_profile.count({ where: { is_banned: true } }),
    ]);
    const summary = { suspended, banned, restricted, shadowBannedProfiles: shadowProfiles, bannedProfiles };

    let rows = [];
    let total = 0;
    if (mode === 'shadow' || mode === 'banned-profiles') {
      const where = mode === 'shadow' ? { is_shadow_banned: true } : { is_banned: true };
      total = mode === 'shadow' ? shadowProfiles : bannedProfiles;
      const profiles = await prisma.social_profile.findMany({
        where, orderBy: { profile_id: 'desc' }, skip: (page - 1) * limit, take: limit,
        select: {
          profile_id: true, display_name: true, handle: true, user_id: true,
          is_shadow_banned: true, is_banned: true,
          user: { select: { name: true, username: true, email: true } },
        },
      });
      rows = profiles.map((p) => ({
        kind: 'profile', profile_id: p.profile_id, user_id: p.user_id,
        display_name: p.display_name, handle: p.handle,
        name: p.user?.name || null, username: p.user?.username || null,
        email: decryptEmail(p.user?.email),
        is_shadow_banned: p.is_shadow_banned, is_banned: p.is_banned,
      }));
    } else {
      total = mode === 'suspended' ? suspended : mode === 'banned' ? banned : restricted;
      const users = await prisma.user.findMany({
        where: { account_status: mode }, orderBy: { status_changed_at: 'desc' },
        skip: (page - 1) * limit, take: limit,
        select: {
          user_id: true, name: true, username: true, email: true, country: true,
          account_status: true, status_reason: true, status_changed_at: true, status_changed_by: true,
        },
      });
      rows = users.map((u) => ({
        kind: 'account', user_id: u.user_id, name: u.name, username: u.username,
        email: decryptEmail(u.email), country: u.country,
        account_status: u.account_status, status_reason: u.status_reason,
        status_changed_at: u.status_changed_at, status_changed_by: u.status_changed_by,
      }));
    }

    res.json({
      mode, summary, total,
      pagination: { page, limit, pages: Math.ceil(total / limit) },
      rows,
      note: 'Enforcement = the current sanction populations (account_status suspended / banned / restricted on the user, and is_shadow_banned / is_banned on the social profile). These are live states, not a request queue — the suspend / ban action itself is a write in the app admin endpoint.',
    });
  } catch (err) {
    console.error('[board-admin/moderation] /enforcement failed:', err);
    res.status(500).json({ error: 'Failed to load enforcement' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────
// GET /ad-review — ads_campaign moderation (PENDING_REVIEW + content-safety flagged).
//   ?mode=queue|flagged   ?page=&limit=
// ─────────────────────────────────────────────────────────────────────────────────────
router.get('/ad-review', async (req, res) => {
  try {
    const mode = ['queue', 'flagged'].includes(req.query.mode) ? req.query.mode : 'queue';
    const page = clampInt(req.query.page, 1, 100000, 1);
    const limit = clampInt(req.query.limit, 1, 100, 25);

    const where = mode === 'queue'
      ? { status: 'PENDING_REVIEW' }
      : { OR: [{ is_sensitive: true }, { safety_score: { lt: 1 } }] };

    const [pendingReview, flagged, total, rows, byStatus] = await Promise.all([
      prisma.ads_campaign.count({ where: { status: 'PENDING_REVIEW' } }),
      prisma.ads_campaign.count({ where: { OR: [{ is_sensitive: true }, { safety_score: { lt: 1 } }] } }),
      prisma.ads_campaign.count({ where }),
      prisma.ads_campaign.findMany({
        where, orderBy: { created_at: 'desc' }, skip: (page - 1) * limit, take: limit,
        select: {
          campaign_id: true, title: true, ad_type: true, vertical: true, status: true,
          is_sensitive: true, safety_score: true, objective: true, created_at: true,
        },
      }),
      prisma.ads_campaign.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);

    res.json({
      mode,
      summary: { pendingReview, flagged },
      total,
      pagination: { page, limit, pages: Math.ceil(total / limit) },
      byStatus: mapGroup(byStatus, 'status'),
      campaigns: rows.map((c) => ({
        campaign_id: c.campaign_id, title: c.title, ad_type: c.ad_type, vertical: c.vertical,
        status: c.status, is_sensitive: c.is_sensitive, safety_score: c.safety_score,
        objective: c.objective, created_at: c.created_at,
      })),
      note: 'Ad review = ad campaigns awaiting content approval (status PENDING_REVIEW) and campaigns the content-safety check flagged (is_sensitive / low safety_score). Approve / reject is a write in the ads-moderation admin endpoint — this view is read-only.',
    });
  } catch (err) {
    console.error('[board-admin/moderation] /ad-review failed:', err);
    res.status(500).json({ error: 'Failed to load ad review' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────
// GET /audit — the moderation action log (social_audit_log).
//   ?action=<exact>  ?search=<action|description ILIKE>  ?page=&limit=
// ─────────────────────────────────────────────────────────────────────────────────────
router.get('/audit', async (req, res) => {
  try {
    const page = clampInt(req.query.page, 1, 100000, 1);
    const limit = clampInt(req.query.limit, 1, 100, 25);
    const where = {};
    if (req.query.action) where.action = String(req.query.action);
    if (req.query.search) where.OR = [
      { action: { contains: String(req.query.search), mode: 'insensitive' } },
      { description: { contains: String(req.query.search), mode: 'insensitive' } },
    ];

    const [total, rows, byAction] = await Promise.all([
      prisma.social_audit_log.count({ where }),
      prisma.social_audit_log.findMany({
        where, orderBy: { created_at: 'desc' }, skip: (page - 1) * limit, take: limit,
      }),
      prisma.social_audit_log.groupBy({ by: ['action'], _count: { _all: true } }),
    ]);

    const targets = await profileSummaries(rows.map((r) => r.profile_id));
    res.json({
      total,
      pagination: { page, limit, pages: Math.ceil(total / limit) },
      byAction: mapGroup(byAction, 'action'),
      filters: { action: req.query.action || null, search: req.query.search || null },
      entries: rows.map((r) => ({
        log_id: r.log_id, action: r.action, description: r.description,
        admin_id: r.admin_id, ip_address: r.ip_address, created_at: r.created_at,
        target: targets[r.profile_id] || null,
      })),
      note: 'Action log = social_audit_log (moderation actions on social profiles — shadow-ban, appeal decisions, …). admin_id is often null (actions were taken by an app admin, not attributed to a board member), and account suspensions are not logged here — they live on the user row.',
    });
  } catch (err) {
    console.error('[board-admin/moderation] /audit failed:', err);
    res.status(500).json({ error: 'Failed to load audit log' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────
// GET /analytics — moderation volume, resolution + breakdowns.
//   ?days=N (default 30)
// ─────────────────────────────────────────────────────────────────────────────────────
router.get('/analytics', async (req, res) => {
  try {
    const days = clampInt(req.query.days, 1, 365, 30);
    const cutoff = daysAgo(days);

    const [byStatus, byTarget, appealByStatus, resolved, dismissed, suspended, banned, restricted] = await Promise.all([
      prisma.social_report.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.social_report.groupBy({ by: ['target_type'], _count: { _all: true } }),
      prisma.content_appeal.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.social_report.count({ where: { status: 'resolved' } }),
      prisma.social_report.count({ where: { status: 'dismissed' } }),
      prisma.user.count({ where: { account_status: 'suspended' } }),
      prisma.user.count({ where: { account_status: 'banned' } }),
      prisma.user.count({ where: { account_status: 'restricted' } }),
    ]);

    // Daily report volume + median resolution time (updated_at − created_at on terminal rows).
    const daily = await prisma.$queryRaw`
      SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS count
      FROM social_report WHERE created_at >= ${cutoff}
      GROUP BY 1 ORDER BY 1 ASC`;
    const resolution = await prisma.$queryRaw`
      SELECT
        AVG(EXTRACT(EPOCH FROM (updated_at - created_at)))::float AS avg_seconds,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (updated_at - created_at)))::float AS median_seconds,
        COUNT(*)::int AS resolved_count
      FROM social_report
      WHERE status IN ('resolved','dismissed') AND updated_at > created_at`;

    res.json({
      days,
      reports: {
        byStatus: mapGroup(byStatus, 'status'),
        byTargetType: mapGroup(byTarget, 'target_type'),
        resolved, dismissed,
        daily: daily.map((d) => ({ day: d.day, count: num(d.count) })),
      },
      resolution: {
        avgSeconds: num(resolution?.[0]?.avg_seconds),
        medianSeconds: num(resolution?.[0]?.median_seconds),
        resolvedCount: num(resolution?.[0]?.resolved_count),
      },
      appeals: { byStatus: mapGroup(appealByStatus, 'status') },
      enforcement: { suspended, banned, restricted },
      note: 'Moderation analytics = aggregates over the report / appeal / enforcement stores. There is no reviewer-productivity or CSAT signal (no moderator workforce store) and no transparency-report export.',
    });
  } catch (err) {
    console.error('[board-admin/moderation] /analytics failed:', err);
    res.status(500).json({ error: 'Failed to load analytics' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// WRITE ACTIONS (enforcement)
//
// These exist because the equivalents under /social-moderation/admin/* are gated by
// `authenticateToken + requireAdmin` — the APP-user admin identity. The dashboard signs
// in as a board_member and holds a board JWT, so it could never call them: staff could
// see the whole trust-&-safety queue and action none of it. Same semantics as the
// app-admin handlers, re-gated on the board capability.
//
// Post-level actions (ban / sensitive / pin / restrict) already exist board-authed under
// /board-admin/townhall/* — the dashboard calls those directly rather than proxying here.
// ─────────────────────────────────────────────────────────────────────────────

const REPORT_STATUSES = ['pending', 'reviewed', 'resolved', 'dismissed'];
const APPEAL_STATUSES = ['pending', 'approved', 'rejected'];

// Best-effort audit trail. social_audit_log keys on profile_id, so an action against a
// non-profile target (a POST/COMMENT/AD report) has no profile to attribute and is simply
// not logged rather than failing the action.
async function logModerationAction(memberId, profileId, action, description, ip) {
  if (!profileId) return;
  try {
    await prisma.social_audit_log.create({
      data: {
        admin_id: memberId ?? null,
        profile_id: profileId,
        action,
        description,
        ip_address: ip || '127.0.0.1',
      },
    });
  } catch (err) {
    console.error('[board-admin/moderation] audit log failed:', err.message);
  }
}

// PATCH /reports/:id — triage a user report. { status: pending|reviewed|resolved|dismissed }
router.patch('/reports/:id', requireDashboard('content-moderation', 'write'), async (req, res) => {
  try {
    const report_id = parseInt(req.params.id, 10);
    if (Number.isNaN(report_id)) return res.status(400).json({ error: 'Invalid report id' });

    const status = String(req.body?.status || '');
    if (!REPORT_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${REPORT_STATUSES.join(', ')}` });
    }

    const existing = await prisma.social_report.findUnique({ where: { report_id } });
    if (!existing) return res.status(404).json({ error: 'Report not found' });

    const updated = await prisma.social_report.update({ where: { report_id }, data: { status } });

    await logModerationAction(
      req.member?.member_id,
      existing.target_type === 'PROFILE' ? existing.target_id : null,
      'REPORT_TRIAGED',
      `${req.member?.name || 'Board member'} set report #${report_id} (${existing.target_type} #${existing.target_id}) to ${status}`,
      req.ip,
    );

    res.json({ successful: true, report_id, status: updated.status });
  } catch (err) {
    console.error('[board-admin/moderation] PATCH /reports/:id failed:', err);
    res.status(500).json({ error: 'Failed to update report' });
  }
});

// PATCH /appeals/:id — decide an appeal. { status: approved|rejected }
// Approving a PROFILE appeal lifts the sanction, mirroring /social-moderation/admin/appeal/:id.
router.patch('/appeals/:id', requireDashboard('content-moderation', 'write'), async (req, res) => {
  try {
    const appeal_id = parseInt(req.params.id, 10);
    if (Number.isNaN(appeal_id)) return res.status(400).json({ error: 'Invalid appeal id' });

    const status = String(req.body?.status || '');
    if (!APPEAL_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${APPEAL_STATUSES.join(', ')}` });
    }

    const existing = await prisma.content_appeal.findUnique({ where: { appeal_id } });
    if (!existing) return res.status(404).json({ error: 'Appeal not found' });

    const appeal = await prisma.$transaction(async (tx) => {
      const a = await tx.content_appeal.update({ where: { appeal_id }, data: { status } });
      if (status === 'approved' && a.target_type === 'PROFILE') {
        await tx.social_profile.update({
          where: { profile_id: a.target_id },
          data: { is_banned: false, is_shadow_banned: false },
        });
      }
      // POST = Instagram-style social_feed; TOWN_HALL_POST = town_hall_post.
      // Previously both branches updated town_hall_post (wrong for social appeals).
      if (status === 'approved' && a.target_type === 'POST') {
        await tx.social_feed.updateMany({
          where: { social_post_id: a.target_id },
          data: { status: 'published', is_sensitive: false },
        });
      }
      if (status === 'approved' && a.target_type === 'TOWN_HALL_POST') {
        await tx.town_hall_post.updateMany({ where: { post_id: a.target_id }, data: { is_banned: false } });
      }
      return a;
    });

    await logModerationAction(
      req.member?.member_id,
      existing.profile_id,
      status === 'approved' ? 'APPEAL_APPROVED' : 'APPEAL_REJECTED',
      `${req.member?.name || 'Board member'} ${status} appeal #${appeal_id} (${existing.target_type} #${existing.target_id})`,
      req.ip,
    );

    res.json({ successful: true, appeal_id, status: appeal.status });
  } catch (err) {
    console.error('[board-admin/moderation] PATCH /appeals/:id failed:', err);
    res.status(500).json({ error: 'Failed to update appeal' });
  }
});

// PATCH /profiles/:profile_id/shadow-ban — toggle a profile's shadow-ban sanction.
router.patch('/profiles/:profile_id/shadow-ban', requireDashboard('content-moderation', 'write'), async (req, res) => {
  try {
    const profile_id = parseInt(req.params.profile_id, 10);
    if (Number.isNaN(profile_id)) return res.status(400).json({ error: 'Invalid profile id' });

    const profile = await prisma.social_profile.findUnique({ where: { profile_id } });
    if (!profile) return res.status(404).json({ error: 'Profile not found' });

    const updated = await prisma.social_profile.update({
      where: { profile_id },
      data: { is_shadow_banned: !profile.is_shadow_banned },
    });

    await logModerationAction(
      req.member?.member_id,
      profile_id,
      updated.is_shadow_banned ? 'SHADOW_BAN' : 'UN_SHADOW_BAN',
      `${req.member?.name || 'Board member'} toggled shadow-ban to ${updated.is_shadow_banned} on profile #${profile_id}`,
      req.ip,
    );

    res.json({ successful: true, profile_id, is_shadow_banned: updated.is_shadow_banned });
  } catch (err) {
    console.error('[board-admin/moderation] PATCH /profiles/:id/shadow-ban failed:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

export default router;
