// routes/board-admin-engineering-routes.js
//
// Read-only Engineering-ops data for the internal dashboards (strug-internal-dashboards →
// Engineering dashboard: Platform Error Log, Monitoring/Observability, Security Engineering).
// Mounted at /board-admin/engineering. NO schema change.
//
// Access tiers (per-route, matching the sensitivity of the data):
//   /errors, /monitoring  → authenticateBoard (any approved member) — video-pipeline errors
//                           and incident-derived uptime are operational, not PII.
//   /security             → authenticateBoard + engineering:write — surfaces user
//                           identities, failed-login IPs, account enforcement + mod audit.
//
// Real data it wires:
//   video (processing_error / processing_status / processing_attempts / moderation_flag /
//          is_nsfw / status='banned')   the platform's only real error/pipeline signal
//   status_incident                     the service uptime / incident store (strug.ca/status)
//   user.account_status (+reason/changed) account enforcement (suspended/banned/restricted)
//   user_activity_event type=auth.login_failed  failed-login audit
//   social_audit_log                    moderation/admin action audit
//   social_report / user_alert          open reports + risk alerts
//   board_member                        board access roster (capability flags → roles)
//
// Genuinely N/A (no store — handled as grey in the dashboard): APM / metrics / tracing /
// latency, alert-rule engine, vulnerability / threat / dependency-code-container scans,
// secrets audit, API-key / token store, IAM beyond the board roster, KYC/AML.

import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateBoard, requireDashboard } from '../middleware/authenticate-board.js';
import { decrypt } from '../utils/crypto.js';
import { getQueueDepths } from '../utils/azure-queue.js';
import { enqueueVideoTask } from '../utils/video-enqueue.js';
import { stalledVideoWhere, stalledTownHallPostWhere, pendingTownHallPostWhere, pendingVideoWhere, RETRY_AFTER_MS, MAX_ATTEMPTS } from '../utils/video-stall.js';
import { getReconciliationHealth } from '../workers/video-reconciliation.js';

const router = express.Router();

// Blob name relative to the container (everything after the first path segment). Chunked uploads
// live under a `raw/` folder, so a naive `.pop()` would drop it and the worker couldn't find the
// source — mirror the fixed blobNameFromUrl in video-routes.js.
function blobNameFromRawUrl(rawUrl) {
  try {
    const segments = new URL(rawUrl).pathname.split('/').filter(Boolean);
    return decodeURIComponent(segments.slice(1).join('/'));
  } catch {
    return (rawUrl || '').split('/').pop() || '';
  }
}

const num = (d) => (d == null ? 0 : Number(d));
const clampInt = (v, lo, hi, dflt) => {
  const n = parseInt(v);
  if (Number.isNaN(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
const mapGroup = (rows, key) =>
  rows.map((r) => ({ name: r[key] == null ? '(none)' : String(r[key]), count: num(r._count?._all) }))
    .sort((a, b) => b.count - a.count);
const pick = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt);

const looksEncrypted = (v) => typeof v === 'string' && v.length >= 32 && v.length % 2 === 0 && /^[0-9a-f]+$/i.test(v);
const decryptEmail = (v) => {
  if (!looksEncrypted(v)) return v;
  try { return decrypt(v); } catch { return v; }
};
async function userSummaries(ids) {
  const unique = [...new Set(ids.filter((x) => x != null))];
  if (!unique.length) return {};
  const users = await prisma.user.findMany({
    where: { user_id: { in: unique } },
    select: { user_id: true, name: true, username: true, email: true },
  });
  const map = {};
  for (const u of users) map[u.user_id] = { user_id: u.user_id, name: u.name, username: u.username, email: decryptEmail(u.email) };
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────────────
// GET /errors — Platform Error Log.  ?mode=overview|pipeline|safety  ?page= ?limit= ?days=
//   The platform's real error signal = video-pipeline failures + content-safety holds.
// ─────────────────────────────────────────────────────────────────────────────────────
router.get('/errors', authenticateBoard, requireDashboard('engineering', 'read'), async (req, res) => {
  try {
    const mode = pick(req.query.mode, ['overview', 'pipeline', 'safety'], 'overview');
    const days = clampInt(req.query.days, 1, 365, 30);
    const cutoff = daysAgo(days);
    const page = clampInt(req.query.page, 1, 100000, 1);
    const limit = clampInt(req.query.limit, 1, 100, 25);
    const skip = (page - 1) * limit;

    const PIPE_WHERE = { OR: [{ processing_error: { not: null } }, { processing_status: 'failed' }] };
    const SAFETY_WHERE = { OR: [{ moderation_flag: { not: null } }, { is_nsfw: true }, { status: 'banned' }] };
    const chanSel = { channel: { select: { handle: true, display_name: true } } };

    if (mode === 'overview') {
      const [pipelineErrors, retryBacklog, stuck, safetyHolds, ongoingIncidents, recentErrs] = await Promise.all([
        prisma.video.count({ where: PIPE_WHERE }),
        prisma.video.count({ where: { processing_attempts: { gte: 2 }, processing_status: { not: 'done' } } }),
        prisma.video.count({ where: { processing_status: 'processing', created_at: { lt: daysAgo(1) } } }),
        prisma.video.count({ where: SAFETY_WHERE }),
        prisma.status_incident.count({ where: { status: 'ongoing' } }),
        prisma.video.findMany({
          where: PIPE_WHERE, orderBy: { updated_at: 'desc' }, take: 12,
          select: { video_id: true, title: true, processing_status: true, processing_error: true, processing_attempts: true, last_attempt_at: true, updated_at: true, ...chanSel },
        }),
      ]);
      const daily = await prisma.$queryRaw`
        SELECT date_trunc('day', updated_at)::date AS day, COUNT(*)::int AS n
        FROM video WHERE (processing_error IS NOT NULL OR processing_status = 'failed') AND updated_at >= ${cutoff}
        GROUP BY 1 ORDER BY 1 ASC`;
      return res.json({
        mode, days,
        counts: { pipelineErrors, retryBacklog, stuckProcessing: stuck, safetyHolds, ongoingIncidents },
        daily: daily.map((d) => ({ day: d.day, errors: num(d.n) })),
        recent: recentErrs.map((v) => ({
          id: v.video_id, title: v.title, processing_status: v.processing_status, error: v.processing_error,
          attempts: v.processing_attempts, last_attempt_at: v.last_attempt_at, updated_at: v.updated_at,
          channel: v.channel ? { handle: v.channel.handle, display_name: v.channel.display_name } : null,
        })),
        note: 'Platform error log = the video-processing pipeline (the only real in-app error store): failed / errored transcodes, retry backlog, stuck jobs, content-safety holds, plus open service incidents. Application / infra errors live in Azure logs, not the DB.',
      });
    }

    if (mode === 'pipeline') {
      const [total, byStatus, rows] = await Promise.all([
        prisma.video.count({ where: PIPE_WHERE }),
        prisma.video.groupBy({ by: ['processing_status'], _count: { _all: true }, where: PIPE_WHERE }),
        prisma.video.findMany({
          where: PIPE_WHERE, orderBy: { updated_at: 'desc' }, skip, take: limit,
          select: { video_id: true, title: true, processing_status: true, processing_error: true, processing_attempts: true, last_attempt_at: true, created_at: true, updated_at: true, ...chanSel },
        }),
      ]);
      return res.json({
        mode, total, byStatus: mapGroup(byStatus, 'processing_status'),
        pagination: { page, limit, pages: Math.ceil(total / limit) },
        errors: rows.map((v) => ({
          id: v.video_id, title: v.title, processing_status: v.processing_status, error: v.processing_error,
          attempts: v.processing_attempts, last_attempt_at: v.last_attempt_at, created_at: v.created_at, updated_at: v.updated_at,
          channel: v.channel ? { handle: v.channel.handle, display_name: v.channel.display_name } : null,
        })),
        note: 'Pipeline failures = videos with a processing_error / failed transcode (with retry-attempt count and last-attempt time).',
      });
    }

    // safety
    const [total, flags, rows] = await Promise.all([
      prisma.video.count({ where: SAFETY_WHERE }),
      prisma.video.groupBy({ by: ['moderation_flag'], _count: { _all: true }, where: { moderation_flag: { not: null } } }),
      prisma.video.findMany({
        where: SAFETY_WHERE, orderBy: { updated_at: 'desc' }, skip, take: limit,
        select: { video_id: true, title: true, status: true, safety_status: true, moderation_flag: true, is_nsfw: true, is_sensitive: true, safety_score: true, updated_at: true, ...chanSel },
      }),
    ]);
    return res.json({
      mode, total, byFlag: mapGroup(flags, 'moderation_flag'),
      pagination: { page, limit, pages: Math.ceil(total / limit) },
      holds: rows.map((v) => ({
        id: v.video_id, title: v.title, status: v.status, safety_status: v.safety_status, moderation_flag: v.moderation_flag,
        is_nsfw: v.is_nsfw, is_sensitive: v.is_sensitive, safety_score: v.safety_score, updated_at: v.updated_at,
        channel: v.channel ? { handle: v.channel.handle, display_name: v.channel.display_name } : null,
      })),
      note: 'Safety holds = videos flagged by the safety pipeline (moderation_flag / is_nsfw / banned). READ-ONLY — moderation decisions are writes in the moderation admin route.',
    });
  } catch (err) {
    console.error('[board-admin/engineering] /errors failed:', err);
    res.status(500).json({ error: 'Failed to load error log' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────
// GET /monitoring — ?mode=overview|errorrates|events  ?days=
//   Uptime / incident health is derived from status_incident (no APM/metrics store).
// ─────────────────────────────────────────────────────────────────────────────────────
router.get('/monitoring', authenticateBoard, requireDashboard('engineering', 'read'), async (req, res) => {
  try {
    const mode = pick(req.query.mode, ['overview', 'errorrates', 'events'], 'overview');
    const days = clampInt(req.query.days, 1, 365, 30);
    const cutoff = daysAgo(days);
    const windowSec = days * 24 * 3600;

    if (mode === 'events') {
      const rows = await prisma.status_incident.findMany({
        orderBy: { started_at: 'desc' }, take: 40,
        select: { id: true, service_id: true, service_name: true, title: true, severity: true, status: true, auto: true, started_at: true, resolved_at: true },
      });
      return res.json({
        mode,
        events: rows.map((r) => ({ id: r.id, service: r.service_name, service_id: r.service_id, title: r.title, severity: r.severity, status: r.status, auto: r.auto, started_at: r.started_at, resolved_at: r.resolved_at })),
        note: 'Monitoring events = the recent service-incident stream (status_incident): automated video-monitor rows + manually-declared incidents.',
      });
    }

    if (mode === 'errorrates') {
      const [totalVideos, failedVideos, safetyHolds] = await Promise.all([
        prisma.video.count({ where: { created_at: { gte: cutoff } } }),
        prisma.video.count({ where: { created_at: { gte: cutoff }, OR: [{ processing_error: { not: null } }, { processing_status: 'failed' }] } }),
        prisma.video.count({ where: { created_at: { gte: cutoff }, OR: [{ moderation_flag: { not: null } }, { is_nsfw: true }] } }),
      ]);
      const daily = await prisma.$queryRaw`
        SELECT date_trunc('day', created_at)::date AS day,
               COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE processing_error IS NOT NULL OR processing_status = 'failed')::int AS failed
        FROM video WHERE created_at >= ${cutoff} GROUP BY 1 ORDER BY 1 ASC`;
      return res.json({
        mode, days,
        totals: { videos: totalVideos, failed: failedVideos, safetyHolds,
          errorRate: totalVideos > 0 ? +((failedVideos / totalVideos) * 100).toFixed(2) : 0 },
        daily: daily.map((d) => ({ day: d.day, total: num(d.total), failed: num(d.failed),
          rate: num(d.total) > 0 ? +((num(d.failed) / num(d.total)) * 100).toFixed(2) : 0 })),
        note: 'Error rates = video-pipeline failure ratio over time (the only measurable in-app error rate). There is no request-level APM / error-rate telemetry in the database.',
      });
    }

    // overview — per-service uptime derived from resolved+ongoing incident durations
    const incidents = await prisma.status_incident.findMany({
      where: { OR: [{ resolved_at: { gte: cutoff } }, { status: 'ongoing' }, { started_at: { gte: cutoff } }] },
      select: { service_id: true, service_name: true, severity: true, status: true, started_at: true, resolved_at: true },
    });
    const now = Date.now();
    const svc = {};
    for (const i of incidents) {
      const s = svc[i.service_id] || (svc[i.service_id] = { service_id: i.service_id, service_name: i.service_name, downtimeSec: 0, incidents: 0, ongoing: 0 });
      s.incidents += 1;
      if (i.status === 'ongoing') s.ongoing += 1;
      // count downtime only for 'down' severity, clamped to the window
      if (i.severity === 'down') {
        const start = Math.max(new Date(i.started_at).getTime(), now - windowSec * 1000);
        const end = i.resolved_at ? new Date(i.resolved_at).getTime() : now;
        s.downtimeSec += Math.max(0, (end - start) / 1000);
      }
    }
    const services = Object.values(svc).map((s) => ({
      ...s, downtimeSec: Math.round(s.downtimeSec),
      uptimePct: +(Math.max(0, (windowSec - s.downtimeSec) / windowSec) * 100).toFixed(3),
    })).sort((a, b) => a.uptimePct - b.uptimePct);
    const [ongoingTotal, byService] = await Promise.all([
      prisma.status_incident.count({ where: { status: 'ongoing' } }),
      prisma.status_incident.groupBy({ by: ['service_id'], _count: { _all: true }, where: { started_at: { gte: cutoff } } }),
    ]);
    return res.json({
      mode, days,
      services,
      overall: { ongoingIncidents: ongoingTotal, windowIncidents: byService.reduce((a, b) => a + num(b._count._all), 0),
        avgUptimePct: services.length ? +(services.reduce((a, b) => a + b.uptimePct, 0) / services.length).toFixed(3) : 100 },
      note: 'Monitoring = service uptime derived from the incident store (downtime = sum of "down"-severity incident durations in the window). No APM / metrics / tracing store exists — latency / throughput / resource telemetry lives in Azure, not the DB.',
    });
  } catch (err) {
    console.error('[board-admin/engineering] /monitoring failed:', err);
    res.status(500).json({ error: 'Failed to load monitoring' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────
// GET /security — ?mode=overview|access|iam|roles  ?days= ?page= ?limit=
//   Sensitive: user identities + failed-login IPs + enforcement. Gated engineering:write (not visible to read-only Analysts).
// ─────────────────────────────────────────────────────────────────────────────────────
router.get('/security', authenticateBoard, requireDashboard('engineering', 'write'), async (req, res) => {
  try {
    const mode = pick(req.query.mode, ['overview', 'access', 'iam', 'roles'], 'overview');
    const days = clampInt(req.query.days, 1, 365, 30);
    const cutoff = daysAgo(days);
    const page = clampInt(req.query.page, 1, 100000, 1);
    const limit = clampInt(req.query.limit, 1, 100, 25);
    const skip = (page - 1) * limit;

    if (mode === 'overview') {
      const [byAccountStatus, failedLogins, openReports, alertsByStatus, modActions, forceLoggedOut] = await Promise.all([
        prisma.user.groupBy({ by: ['account_status'], _count: { _all: true } }),
        prisma.user_activity_event.count({ where: { type: 'auth.login_failed', created_at: { gte: cutoff } } }),
        prisma.social_report.count({ where: { status: 'pending' } }),
        prisma.user_alert.groupBy({ by: ['status'], _count: { _all: true } }),
        prisma.social_audit_log.count({ where: { created_at: { gte: cutoff } } }),
        prisma.user.count({ where: { sessions_invalidated_at: { not: null, gte: cutoff } } }),
      ]);
      const failedDaily = await prisma.$queryRaw`
        SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS n
        FROM user_activity_event WHERE type = 'auth.login_failed' AND created_at >= ${cutoff}
        GROUP BY 1 ORDER BY 1 ASC`;
      const enforcement = mapGroup(byAccountStatus, 'account_status');
      const val = (name) => enforcement.find((e) => e.name === name)?.count || 0;
      return res.json({
        mode, days,
        enforcement: { suspended: val('suspended'), banned: val('banned'), restricted: val('restricted'), active: val('active'), byStatus: enforcement },
        failedLogins: { window: failedLogins, forceLoggedOut,
          daily: failedDaily.map((d) => ({ day: d.day, failed: num(d.n) })) },
        openReports, modActions,
        alerts: mapGroup(alertsByStatus, 'status'),
        note: 'Security overview = account enforcement (account_status), failed-login volume, open user reports, moderation-audit actions and risk alerts. Vulnerability / dependency / secrets scanning runs outside the app (no store).',
      });
    }

    if (mode === 'access') {
      const [total, rows] = await Promise.all([
        prisma.user_activity_event.count({ where: { type: 'auth.login_failed', created_at: { gte: cutoff } } }),
        prisma.user_activity_event.findMany({
          where: { type: 'auth.login_failed', created_at: { gte: cutoff } },
          orderBy: { created_at: 'desc' }, skip, take: limit,
          select: { event_id: true, user_id: true, description: true, ip_address: true, created_at: true },
        }),
      ]);
      const users = await userSummaries(rows.map((r) => r.user_id));
      const auditRecent = await prisma.social_audit_log.findMany({
        orderBy: { created_at: 'desc' }, take: 20,
        select: { log_id: true, admin_id: true, action: true, description: true, created_at: true },
      });
      return res.json({
        mode, total,
        pagination: { page, limit, pages: Math.ceil(total / limit) },
        failedLogins: rows.map((e) => ({ id: e.event_id, description: e.description, ip: e.ip_address, created_at: e.created_at, user: users[e.user_id] || { user_id: e.user_id } })),
        auditActions: auditRecent.map((a) => ({ id: a.log_id, admin_id: a.admin_id, action: a.action, description: a.description, created_at: a.created_at })),
        note: 'Access logs = failed-login events (user_activity_event) with IP + identity, plus the recent moderation/admin action audit (social_audit_log).',
      });
    }

    if (mode === 'iam') {
      const [total, byStatus, rows] = await Promise.all([
        prisma.board_member.count(),
        prisma.board_member.groupBy({ by: ['status'], _count: { _all: true } }),
        prisma.board_member.findMany({
          orderBy: { created_at: 'desc' }, skip, take: limit,
          select: { member_id: true, name: true, email: true, status: true, can_assign: true, can_review: true, can_manage_members: true, can_view_users: true, created_at: true, approved_at: true },
        }),
      ]);
      return res.json({
        mode, total, byStatus: mapGroup(byStatus, 'status'),
        pagination: { page, limit, pages: Math.ceil(total / limit) },
        members: rows.map((m) => ({
          id: m.member_id, name: m.name, email: m.email, status: m.status,
          caps: { assign: m.can_assign, review: m.can_review, manage: m.can_manage_members, viewUsers: m.can_view_users },
          created_at: m.created_at, approved_at: m.approved_at,
        })),
        note: 'IAM = the board-member access roster (dashboard/API identities) with approval status + capability flags. App-user IAM beyond account_status enforcement is not modeled.',
      });
    }

    // roles — derived role distribution from capability flags
    const members = await prisma.board_member.findMany({
      select: { member_id: true, name: true, email: true, status: true, can_assign: true, can_review: true, can_manage_members: true, can_view_users: true },
    });
    const roleOf = (m) => m.can_manage_members ? 'Admin' : m.can_assign ? 'Lead' : m.can_review ? 'Reviewer' : m.can_view_users ? 'Analyst' : 'Member';
    const dist = {};
    for (const m of members) { const r = roleOf(m); dist[r] = (dist[r] || 0) + 1; }
    return res.json({
      mode,
      roles: Object.entries(dist).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      members: members.map((m) => ({ id: m.member_id, name: m.name, email: m.email, status: m.status, role: roleOf(m) })),
      note: 'Roles = board-member roles derived from capability flags (Admin=manage-members, Lead=assign, Reviewer=review, Analyst=view-users, else Member). There is no separate RBAC role store.',
    });
  } catch (err) {
    console.error('[board-admin/engineering] /security failed:', err);
    res.status(500).json({ error: 'Failed to load security' });
  }
});

// POST /board-admin/engineering/video-pipeline/requeue
// Recovery action for the Engineering dashboard's video-pipeline section. The reconciliation
// worker only retries videos stuck in pending/processing — it deliberately skips terminal
// 'error'/'failed' rows, so videos that errored during an outage never recover on their own.
// This resets those rows (that still have a real raw asset) to 'pending' and re-enqueues them
// for transcoding. Supports ?dry_run=true to preview the candidate set without mutating.
// Gated by engineering:write — this mutates the pipeline, so it's manage-tier, not read-only.
router.post('/video-pipeline/requeue', authenticateBoard, requireDashboard('engineering', 'write'), async (req, res) => {
  try {
    const dryRun = req.query.dry_run === 'true' || req.body?.dry_run === true;
    const limit = clampInt(req.query.limit ?? req.body?.limit, 1, 1000, 500);

    const candidates = await prisma.video.findMany({
      where: {
        status: { not: 'banned' },
        raw_video_url: { not: 'pending_upload' },
        hls_url: null,
        processing_status: { in: ['error', 'failed'] },
      },
      select: { video_id: true, raw_video_url: true },
      orderBy: { video_id: 'asc' },
      take: limit,
    });

    if (dryRun) {
      return res.json({ successful: true, dry_run: true, candidate_count: candidates.length, video_ids: candidates.map(v => v.video_id) });
    }

    const requeued = [];
    const skipped = [];
    for (const v of candidates) {
      const blobName = blobNameFromRawUrl(v.raw_video_url);
      if (!blobName) { skipped.push(v.video_id); continue; }
      try {
        await prisma.video.update({
          where: { video_id: v.video_id },
          data: { processing_status: 'pending', processing_attempts: 0, processing_error: null, last_attempt_at: new Date() },
        });
        await enqueueVideoTask(v.video_id, blobName).catch(() => {});
        requeued.push(v.video_id);
      } catch {
        skipped.push(v.video_id);
      }
    }

    return res.json({ successful: true, requeued_count: requeued.length, skipped_count: skipped.length, video_ids: requeued });
  } catch (err) {
    console.error('[board-admin/engineering] /video-pipeline/requeue failed:', err);
    res.status(500).json({ successful: false, error: 'Requeue failed' });
  }
});

// ── GET /board-admin/engineering/video-pipeline ────────────────────────────────────────────────
//
// The live transcode pipeline: lanes, in-flight work, stalls, throughput. Read-only.
//
// This exists because of what the Engineering dashboard COULDN'T tell us on 2026-07-14. A 10-hour
// upload (video 13) split into 600 chunks, the worker tried to spawn ~300 Azure jobs at once, Azure
// refused, orchestration collapsed, and it silently fell back to transcoding 600 chunks one at a
// time — for hours, holding a worker slot, re-staging all 600 on every retry, and starving the
// job quota so that OTHER people's videos failed too. The Error Log showed exactly one thing:
// "1 stuck job". Every question worth asking — is the queue backed up, is a worker even alive, is
// this video progressing or dead — had to be answered from raw Log Analytics.
//
// So the panel is built around the one question the old view could never answer:
//
//   IS THIS VIDEO GRINDING, OR IS IT DEAD?
//
// It is answerable now only because the worker persists a progress heartbeat into last_attempt_at
// (strug_worker#129). Before that, last_attempt_at was stamped once at the start of a run and never
// moved, so a healthy 10-hour transcode and a corpse looked identical from the database. That's the
// whole reason "stuck" was such a useless word here.
const HEARTBEAT_FRESH_MS = 15 * 60 * 1000;  // 3 missed 5-minute stamps ⇒ the worker has gone quiet

// A row's state, from the age of its heartbeat. The thresholds are the pipeline's own, not new
// numbers: RETRY_AFTER_MS is the exact point at which the sweep re-queues and the monitor pages.
export function heartbeatState(lastAttemptAt, now) {
  if (!lastAttemptAt) return 'no-heartbeat';                       // enqueue lost, or never started
  const age = now - new Date(lastAttemptAt).getTime();
  if (age > RETRY_AFTER_MS) return 'stalled';                      // the sweep will re-queue this
  if (age > HEARTBEAT_FRESH_MS) return 'silent';                   // suspicious, not yet actionable
  return 'grinding';                                               // actively reporting progress
}

const minsSince = (d, now) => (d ? Math.round((now - new Date(d).getTime()) / 60000) : null);

router.get('/video-pipeline', authenticateBoard, requireDashboard('engineering', 'read'), async (req, res) => {
  try {
    const now = Date.now();
    const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
    const hourAgo = new Date(now - 60 * 60 * 1000);

    const inFlightSel = { select: { video_id: true, title: true, created_at: true, last_attempt_at: true, processing_attempts: true } };

    const [
      depths, inFlightVideos, inFlightPosts, stalledVideos, stalledPosts,
      recentErrors, doneLastHour, doneLastDay, errorCount,
      pendingTownHall, doneTownHallLastHour, doneTownHallLastDay, pendingVideos,
    ] = await Promise.all([
      getQueueDepths(),
      // In flight = the worker claims to be working on it. Ordered oldest-first: the one most likely
      // to be wedged is the one you want at the top.
      prisma.video.findMany({ where: { processing_status: 'processing', hls_url: null }, orderBy: { created_at: 'asc' }, take: 25, ...inFlightSel }),
      prisma.town_hall_post.findMany({
        where: { processing_status: 'processing', hls_url: null },
        orderBy: { created_at: 'asc' }, take: 25,
        select: { post_id: true, created_at: true, last_attempt_at: true, processing_attempts: true },
      }),
      // The SHARED stall predicate — the same one the sweep re-queues on and the monitor pages on.
      // Hand-rolling a second definition here is exactly how the alert started lying last time.
      prisma.video.findMany({ where: stalledVideoWhere(now), orderBy: { created_at: 'asc' }, take: 25, ...inFlightSel }),
      prisma.town_hall_post.count({ where: stalledTownHallPostWhere(now) }),
      prisma.video.findMany({
        where: { processing_status: 'error', updated_at: { gte: dayAgo } },
        orderBy: { updated_at: 'desc' }, take: 10,
        select: { video_id: true, title: true, processing_error: true, processing_attempts: true, updated_at: true },
      }),
      prisma.video.count({ where: { processing_status: 'done', updated_at: { gte: hourAgo } } }),
      prisma.video.count({ where: { processing_status: 'done', updated_at: { gte: dayAgo } } }),
      prisma.video.count({ where: { processing_status: 'error', hls_url: null } }),
      // ── Town hall: the panel used to count prisma.video ONLY, which made the bulk lane
      // uninterpretable. A flat bulk depth of ~490 against 20 stalled posts could equally be 490 real
      // posts (a throughput problem) or 20 posts + 470 duplicate re-queues from the 15-minute sweep
      // (a debounce problem) — opposite fixes, and no way to choose between them. `pendingTownHall`
      // is the denominator that settles it: bulk depth MINUS pendingTownHall is the duplicate load.
      // Done/hour + done/day give the drain rate, so "flat" can be told from "stuck".
      prisma.town_hall_post.count({ where: pendingTownHallPostWhere() }),
      prisma.town_hall_post.count({ where: { processing_status: 'done', updated_at: { gte: hourAgo } } }),
      prisma.town_hall_post.count({ where: { processing_status: 'done', updated_at: { gte: dayAgo } } }),
      // Videos-vertical outstanding work — compare to lanes.interactive the same way.
      prisma.video.count({ where: pendingVideoWhere() }),
    ]);

    const shape = (rows, kind) => rows.map((r) => {
      const id = kind === 'video' ? r.video_id : r.post_id;
      return {
        id,
        kind,
        title: kind === 'video' ? (r.title ?? null) : `Town hall post ${id}`,
        attempts: r.processing_attempts,
        maxAttempts: MAX_ATTEMPTS,
        ageMin: minsSince(r.created_at, now),               // how long since upload
        heartbeatAgeMin: minsSince(r.last_attempt_at, now), // how long since the worker last reported
        state: heartbeatState(r.last_attempt_at, now),
      };
    });

    const inFlight = [...shape(inFlightVideos, 'video'), ...shape(inFlightPosts, 'townhall')]
      .sort((a, b) => (b.ageMin ?? 0) - (a.ageMin ?? 0));

    const { lastSweepSuccessAt } = getReconciliationHealth();

    res.json({
      generatedAt: new Date(now).toISOString(),
      // Depth EXCLUDES leased/deferred messages, so a lane can read 0 with work in flight. The UI
      // labels it approximate for that reason — read it next to inFlight, never alone.
      lanes: depths,
      // The sweep runs IN-PROCESS and stamps its heartbeat every 15m, so right after a deploy
      // lastSuccessAt is legitimately null — the first run simply hasn't happened yet. Without
      // uptime the UI cannot tell "hasn't run YET" from "has stopped running", and would cry
      // SAFETY NET DOWN for a quarter of an hour after every deploy. The pipeline monitor already
      // solves this with a boot grace (BOOT_GRACE_MS = 20m); ship the same fact so the panel can.
      sweep: {
        lastSuccessAt: lastSweepSuccessAt ? new Date(lastSweepSuccessAt).toISOString() : null,
        ageMin: lastSweepSuccessAt ? Math.round((now - lastSweepSuccessAt) / 60000) : null,
        uptimeMin: Math.round(process.uptime() / 60),
        bootGraceMin: 20,
      },
      counts: {
        inFlight: inFlight.length,
        grinding: inFlight.filter((r) => r.state === 'grinding').length,
        silent: inFlight.filter((r) => r.state === 'silent').length,
        stalledVideos: stalledVideos.length,
        stalledTownHall: stalledPosts,
        errored: errorCount,
        doneLastHour,
        doneLastDay,
        // Outstanding town hall transcode work — the denominator for the bulk lane. Read it next to
        // lanes.bulk: depth ≫ pendingTownHall means the queue is mostly duplicate re-queues.
        pendingTownHall,
        doneTownHallLastHour,
        doneTownHallLastDay,
        // Outstanding Videos-vertical work — denominator for lanes.interactive.
        pendingVideos,
      },
      inFlight,
      stalled: shape(stalledVideos, 'video'),
      recentErrors: recentErrors.map((v) => ({
        id: v.video_id,
        title: v.title ?? null,
        error: v.processing_error,
        attempts: v.processing_attempts,
        at: v.updated_at,
      })),
      thresholds: {
        heartbeatFreshMin: Math.round(HEARTBEAT_FRESH_MS / 60000),
        retryAfterMin: Math.round(RETRY_AFTER_MS / 60000),
        maxAttempts: MAX_ATTEMPTS,
      },
    });
  } catch (err) {
    console.error('[engineering] video-pipeline failed:', err);
    res.status(500).json({ error: 'Failed to load video pipeline state' });
  }
});

export default router;
