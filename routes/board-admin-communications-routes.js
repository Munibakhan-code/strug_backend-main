// routes/board-admin-communications-routes.js
//
// Read-only Communications data for the internal dashboards (strug-internal-dashboards
// → Communications dashboard). Gated by the board identity + can_manage_members (the
// admin tier), matching Finance / Operations / Vertical Management / Customer Support /
// Analytics / Product. Mounted at /board-admin/communications. ALL endpoints READ-ONLY.
//
// The Communications dashboard is the platform's communication & coordination view. Most
// of it COMPOSES FE-side from endpoints the other dashboards already ship:
//   - messaging / channels / threads / social / streaming → /board-admin/product/engagement
//   - video / content                                     → /board-admin/analytics/content
//   - incidents (incident communications)                 → /board-admin/customer-support/incidents
//   - tasks (task collaboration / project rooms)          → /board/tasks
//   - account_status (restricted users)                   → /board-admin/customer-support/accounts
//   - feature requests                                    → /board-admin/customer-support/tickets
//
// The ONLY surfaces not covered anywhere are the INTERNAL STAFF coordination signals:
//
//   GET /people        the board_member staff roster — directory + status (approved /
//                      pending) + capability-derived role. Backs People (directory /
//                      colleague profiles / search), Approvals & Workflows (pending /
//                      history), and the staff permission matrix (Access / User / Role
//                      Permissions). The /board/tasks/members endpoint only returns
//                      APPROVED members with a couple of fields — too thin for this.
//   GET /notifications the board_notification stream PLATFORM-WIDE (the in-app task-board
//                      notification feed: assignment / review / approved / comment …).
//                      The /board/notifications endpoint is CALLER-SCOPED (a member's own
//                      bell) — this aggregates across all members for the dashboard.
//   GET /moderation    the social_report content-moderation store (reported posts /
//                      comments / users) — reported content + review queue.
//   GET /overview      a small staff + notification + moderation rollup for HOME.
//
// Everything else stays FE-composed, keeping this router thin and dodging deploy risk
// for everything but these genuinely-new internal-coordination aggregates.

import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateBoard, requireDashboard } from '../middleware/authenticate-board.js';

const router = express.Router();
router.use(authenticateBoard, requireDashboard('communications', 'read'));

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

// A board member's "role" is derived from its capability flags (there's no role column —
// only can_assign / can_review / can_manage_members / can_view_users booleans).
const roleOf = (m) =>
  m.can_manage_members ? 'Admin'
    : m.can_review ? 'Reviewer'
      : m.can_assign ? 'Lead'
        : m.can_view_users ? 'Analyst'
          : 'Member';
const memberOut = (m) => ({
  member_id: m.member_id,
  name: m.name,
  email: m.email,
  status: m.status,
  role: roleOf(m),
  can_assign: m.can_assign,
  can_review: m.can_review,
  can_manage_members: m.can_manage_members,
  can_view_users: m.can_view_users,
  created_at: m.created_at,
  approved_at: m.approved_at,
});

// ── GET /people — staff roster (directory + rollup) ──────────────────────────────────
// ?status (approved|pending|all, default all), ?search, ?page, ?limit.
router.get('/people', async (req, res) => {
  try {
    const status = ['approved', 'pending'].includes(req.query.status) ? req.query.status : null;
    const search = (req.query.search || '').trim();
    const page = clampInt(req.query.page, 1, 100000, 1);
    const limit = clampInt(req.query.limit, 1, 200, 50);

    const where = {};
    if (status) where.status = status;
    if (search) where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
    ];

    const memberSelect = {
      member_id: true, name: true, email: true, status: true,
      can_assign: true, can_review: true, can_manage_members: true, can_view_users: true,
      created_at: true, approved_at: true,
    };

    const [total, approved, pending, managers, reviewers, assigners, viewers, filtered, rows, dailyRaw] =
      await Promise.all([
        prisma.board_member.count(),
        prisma.board_member.count({ where: { status: 'approved' } }),
        prisma.board_member.count({ where: { status: 'pending' } }),
        prisma.board_member.count({ where: { can_manage_members: true } }),
        prisma.board_member.count({ where: { can_review: true } }),
        prisma.board_member.count({ where: { can_assign: true } }),
        prisma.board_member.count({ where: { can_view_users: true } }),
        prisma.board_member.count({ where }),
        prisma.board_member.findMany({
          where, select: memberSelect, orderBy: [{ status: 'asc' }, { name: 'asc' }],
          skip: (page - 1) * limit, take: limit,
        }),
        prisma.$queryRaw`
          SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS date, COUNT(*)::int AS joined
          FROM board_member GROUP BY 1 ORDER BY 1 ASC`,
      ]);

    res.json({
      summary: {
        total, approved, pending,
        managers, reviewers, assigners, viewers,
        member: total - managers - reviewers - assigners, // rough "plain member" headcount
      },
      daily: (dailyRaw || []).map((r) => ({ date: r.date, joined: num(r.joined) })),
      directory: rows.map(memberOut),
      pagination: { page, limit, total: filtered, pages: Math.max(1, Math.ceil(filtered / limit)) },
      note: 'The internal staff roster = board_member (the dev/staff identities behind board-auth). Role is derived from capability flags (Admin = can_manage_members, Reviewer = can_review, Lead = can_assign, Analyst = can_view_users). There are no department / team / timezone / presence fields — those views are Not Applicable.',
    });
  } catch (err) {
    console.error('[board-admin/communications] /people failed:', err);
    res.status(500).json({ error: 'Failed to load people' });
  }
});

// ── GET /notifications — platform-wide board_notification stream ──────────────────────
// ?days (7..180, default 30) scopes the daily series + recent feed.
router.get('/notifications', async (req, res) => {
  try {
    const days = clampInt(req.query.days, 7, 180, 30);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [total, unread, byTypeRaw, dailyRaw, recent, members] = await Promise.all([
      prisma.board_notification.count(),
      prisma.board_notification.count({ where: { is_read: false } }),
      prisma.board_notification.groupBy({ by: ['type'], _count: { _all: true } }),
      prisma.$queryRaw`
        SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS date, COUNT(*)::int AS count
        FROM board_notification WHERE created_at >= ${cutoff}
        GROUP BY 1 ORDER BY 1 ASC`,
      prisma.board_notification.findMany({
        orderBy: { created_at: 'desc' }, take: 40,
        select: { notification_id: true, member_id: true, type: true, body: true, is_read: true, created_at: true, task_id: true },
      }),
      prisma.board_member.findMany({ select: { member_id: true, name: true, email: true } }),
    ]);

    const nameById = new Map(members.map((m) => [m.member_id, m.name || m.email]));

    res.json({
      days,
      summary: { total, unread, read: total - unread },
      byType: mapGroup(byTypeRaw, 'type'),
      daily: (dailyRaw || []).map((r) => ({ date: r.date, count: num(r.count) })),
      recent: recent.map((n) => ({
        notification_id: n.notification_id,
        type: n.type,
        body: n.body,
        is_read: n.is_read,
        created_at: n.created_at,
        task_id: n.task_id,
        recipient: nameById.get(n.member_id) || `Member #${n.member_id}`,
      })),
      note: 'Internal staff notifications = the board_notification stream (the task-board bell: assignment / ready-for-review / changes-requested / approved / on-staging / done / comment / account-approved). These are automated workflow notifications to staff; there is no separate push / email / digest preference store, so those settings are Not Applicable.',
    });
  } catch (err) {
    console.error('[board-admin/communications] /notifications failed:', err);
    res.status(500).json({ error: 'Failed to load notifications' });
  }
});

// ── GET /moderation — social_report content-moderation store ──────────────────────────
router.get('/moderation', async (_req, res) => {
  try {
    const [total, pending, byStatusRaw, byTargetRaw, recent] = await Promise.all([
      prisma.social_report.count(),
      prisma.social_report.count({ where: { status: 'pending' } }),
      prisma.social_report.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.social_report.groupBy({ by: ['target_type'], _count: { _all: true } }),
      prisma.social_report.findMany({
        orderBy: { created_at: 'desc' }, take: 30,
        select: { report_id: true, target_type: true, target_id: true, reason: true, status: true, created_at: true },
      }),
    ]);

    res.json({
      summary: { total, pending, resolved: total - pending },
      byStatus: mapGroup(byStatusRaw, 'status'),
      byTargetType: mapGroup(byTargetRaw, 'target_type'),
      recent: recent.map((r) => ({
        report_id: r.report_id,
        target_type: r.target_type,
        target_id: r.target_id,
        reason: r.reason,
        status: r.status,
        created_at: r.created_at,
      })),
      note: 'Content moderation = the social_report store (user-reported posts / comments / profiles, with a reason and a pending → resolved status). This is the only content-report queue in the platform; reporter identity is withheld here.',
    });
  } catch (err) {
    console.error('[board-admin/communications] /moderation failed:', err);
    res.status(500).json({ error: 'Failed to load moderation' });
  }
});

// ── GET /overview — small staff + notification + moderation rollup for HOME ────────────
router.get('/overview', async (req, res) => {
  try {
    const days = clampInt(req.query.days, 7, 180, 30);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [
      staffTotal, staffApproved, staffPending,
      notifTotal, notifUnread, notifRecent, notifDailyRaw,
      modTotal, modPending,
    ] = await Promise.all([
      prisma.board_member.count(),
      prisma.board_member.count({ where: { status: 'approved' } }),
      prisma.board_member.count({ where: { status: 'pending' } }),
      prisma.board_notification.count(),
      prisma.board_notification.count({ where: { is_read: false } }),
      prisma.board_notification.count({ where: { created_at: { gte: cutoff } } }),
      prisma.$queryRaw`
        SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS date, COUNT(*)::int AS count
        FROM board_notification WHERE created_at >= ${cutoff}
        GROUP BY 1 ORDER BY 1 ASC`,
      prisma.social_report.count(),
      prisma.social_report.count({ where: { status: 'pending' } }),
    ]);

    res.json({
      days,
      staff: { total: staffTotal, approved: staffApproved, pending: staffPending },
      notifications: {
        total: notifTotal, unread: notifUnread, recent: notifRecent,
        daily: (notifDailyRaw || []).map((r) => ({ date: r.date, count: num(r.count) })),
      },
      moderation: { total: modTotal, pending: modPending },
      note: 'Communications overview = the internal-coordination rollup (staff roster, the task-board notification stream, and the content-moderation queue). Messaging / channels / social / incidents are composed FE-side from the Product engagement and Customer-Support incident endpoints.',
    });
  } catch (err) {
    console.error('[board-admin/communications] /overview failed:', err);
    res.status(500).json({ error: 'Failed to load communications overview' });
  }
});

export default router;
