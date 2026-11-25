// routes/board-admin-customer-support-routes.js
//
// Read-only Customer Support data for the internal dashboards (strug-internal-dashboards
// → Customer Support dashboard). Gated by the board identity + can_manage_members (the
// admin tier) — it exposes reporter emails, so it sits at the same tier as Finance /
// Operations / Vertical Management.
//
// Mounted at /board-admin/customer-support. ALL endpoints are READ-ONLY. Customer
// Support is a triage/case VIEW over the platform's real inbound signals — the platform
// has no helpdesk product (no ticketing engine, agents, live chat/SMS/phone, SLA store,
// CSAT/NPS, knowledge base, macros, automation). So the wired surface is intentionally
// small and honest; everything that would need a helpdesk apparatus is marked N/A in the
// dashboard, not faked here.
//
// The real data this reads:
//   bug_report          — THE ticket/case backbone (status open/in_progress/resolved/
//                         wont_fix/duplicate → buckets open·pending·resolved·closed).
//                         Read-only here; the Engineering dashboard's Bug Tracker owns
//                         the same rows for the dev lens + the triage WRITE path
//                         (PATCH /bug-reports/admin). We never mutate from here.
//   contact_submissions — the public contact form (→ Resend). The inbound "Email Inbox".
//   status_incident     — the strug.ca/status incident store (Incident Center).
//   user.account_status — who is suspended / banned / restricted (read-only context for
//                         the "appeals" sections — there is NO appeals store, so these
//                         are populations, not request queues, and the UI says so).
//
//   GET /overview     ticket KPIs (per-bucket / today / by category / by severity) +
//                     open incidents + contact-inbox pending + by-vertical (page_url)
//   GET /tickets      the workhorse: bug_report feed, normalized + bucketed, with
//                     status/bucket/category/severity/assigned/priority/vertical/search
//                     filters + pagination
//   GET /inbox        contact_submissions feed (status/search + pagination)
//   GET /incidents    status_incident folded over the service registry (mirrors the
//                     Engineering status board shape)
//   GET /analytics    ticket volume (daily) + category breakdown + resolution time
//                     (resolved updated_at − created_at) + severity/status mix
//   GET /accounts     account_status populations (suspended / banned / restricted) —
//                     read-only context for Suspension/Ban Appeals + Account Recovery

import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateBoard, requireDashboard } from '../middleware/authenticate-board.js';
import { decrypt } from '../utils/crypto.js';
import { STATUS_SERVICES, summarizeServices, overallStatus } from './status-routes.js';

const router = express.Router();
router.use(authenticateBoard, requireDashboard('customer-support', 'read'));

const num = (d) => (d == null ? 0 : Number(d));
const clampInt = (v, lo, hi, dflt) => {
  const n = parseInt(v);
  if (Number.isNaN(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};

// user.email (and the snapshotted bug_report.email) is encrypted at rest (deterministic
// AES); this board endpoint is authorized to display it. Only decrypt hex ciphertext.
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
    select: {
      user_id: true, name: true, username: true, email: true,
      social_profiles: { select: { display_name: true, handle: true } },
    },
  });
  const map = {};
  for (const u of users) {
    map[u.user_id] = {
      user_id: u.user_id,
      name: u.name,
      username: u.username,
      email: decryptEmail(u.email),
      display_name: u.social_profiles?.display_name || null,
      handle: u.social_profiles?.handle || null,
    };
  }
  return map;
}

// ── ticket status ↔ support bucket ──────────────────────────────────────────────
// bug_report.status is the source of truth; we reframe it into a support-triage
// lifecycle. There is no real assignment/escalation engine — "Pending" just means
// in_progress, and "assigned" is derived from the presence of a triage admin_note.
const STATUSES = ['open', 'in_progress', 'resolved', 'wont_fix', 'duplicate'];
const SEVERITIES = ['low', 'medium', 'high', 'critical'];
// bucket → the bug_report statuses it covers. `active` = the live workload (open + in_progress).
const BUCKET_STATUSES = {
  open: ['open'],
  pending: ['in_progress'],
  resolved: ['resolved'],
  closed: ['wont_fix', 'duplicate'],
  active: ['open', 'in_progress'],
};
const bucketOf = (status) => {
  if (status === 'open') return 'open';
  if (status === 'in_progress') return 'pending';
  if (status === 'resolved') return 'resolved';
  return 'closed'; // wont_fix | duplicate | anything unknown
};

// By Vertical is a best-effort heuristic from the page the report was filed on
// (bug_report.page_url) — the platform doesn't tag tickets with a vertical.
const VERTICAL_RULES = [
  { vertical: 'food', label: 'Food & grocery', keywords: ['/food', '/grocery', '/restaurant', '/floral', '/catering'] },
  { vertical: 'shop', label: 'Ecommerce', keywords: ['/shop', '/product', '/store', '/marketplace', '/ecommerce'] },
  { vertical: 'rideshare', label: 'Rideshare', keywords: ['/ride', '/rides', '/driver', '/trip'] },
  { vertical: 'courier', label: 'Courier', keywords: ['/courier', '/delivery', '/package'] },
  { vertical: 'booking', label: 'Bookings', keywords: ['/booking', '/book', '/reservation', '/stay', '/hotel', '/rental'] },
  { vertical: 'video', label: 'Video & live', keywords: ['/video', '/videos', '/watch', '/live', '/short', '/stream', '/v/'] },
  { vertical: 'social', label: 'Social & profile', keywords: ['/profile', '/@', '/town-hall', '/social', '/feed', '/messages', '/chat'] },
  { vertical: 'work', label: 'On-demand work', keywords: ['/work', '/job', '/hire', '/service'] },
  { vertical: 'wallet', label: 'Wallet & payments', keywords: ['/wallet', '/payment', '/checkout', '/payout', '/billing'] },
  { vertical: 'account', label: 'Account & auth', keywords: ['/login', '/signup', '/register', '/account', '/settings', '/auth', '/verify'] },
];
function verticalOf(pageUrl) {
  const u = String(pageUrl || '').toLowerCase();
  if (!u) return { vertical: 'unknown', label: 'Unknown / not captured' };
  for (const r of VERTICAL_RULES) {
    if (r.keywords.some((k) => u.includes(k))) return { vertical: r.vertical, label: r.label };
  }
  return { vertical: 'other', label: 'Other / homepage' };
}

function normalizeTicket(r, users) {
  const reporter = r.user_id != null ? (users[r.user_id] || null) : null;
  const v = verticalOf(r.page_url);
  return {
    id: r.bug_report_id,
    title: r.title,
    description: r.description,
    user_id: r.user_id,
    user: reporter,
    // Prefer the live user email; fall back to the snapshotted (encrypted) email column.
    email: reporter?.email || decryptEmail(r.email) || null,
    category: r.category,
    severity: r.severity,
    status: r.status,
    bucket: bucketOf(r.status),
    assigned: Boolean(r.admin_note && r.admin_note.trim()),
    admin_note: r.admin_note || null,
    page_url: r.page_url || null,
    vertical: v.vertical,
    vertical_label: v.label,
    attachments: r._count?.screenshots ?? 0,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// ─── OVERVIEW (ticket KPIs + incidents + contact inbox) ──────────────────────────
router.get('/overview', async (req, res) => {
  try {
    const now = new Date();
    const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
    const cutoff7 = new Date(now.getTime() - 7 * 86400000);

    const [byStatus, byCategory, bySeverity, todayCount, weekCount, totalTickets, assignedCount,
      ongoingIncidents, contactPending, contactTotal, pageUrls] = await Promise.all([
      prisma.bug_report.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.bug_report.groupBy({ by: ['category'], _count: { _all: true } }),
      prisma.bug_report.groupBy({ by: ['severity'], _count: { _all: true } }),
      prisma.bug_report.count({ where: { created_at: { gte: todayStart } } }),
      prisma.bug_report.count({ where: { created_at: { gte: cutoff7 } } }),
      prisma.bug_report.count(),
      prisma.bug_report.count({ where: { admin_note: { not: null } } }),
      prisma.status_incident.findMany({ where: { status: 'ongoing' }, orderBy: { started_at: 'desc' } }),
      prisma.contact_submissions.count({ where: { status: 'pending' } }),
      prisma.contact_submissions.count(),
      prisma.bug_report.findMany({ select: { page_url: true } }),
    ]);

    // fold statuses into the 4 support buckets
    const buckets = { open: 0, pending: 0, resolved: 0, closed: 0 };
    const statusMap = {};
    for (const s of byStatus) { statusMap[s.status] = s._count._all; buckets[bucketOf(s.status)] += s._count._all; }

    // by-vertical from page_url heuristic
    const vmap = {};
    for (const r of pageUrls) {
      const v = verticalOf(r.page_url);
      if (!vmap[v.vertical]) vmap[v.vertical] = { vertical: v.vertical, label: v.label, count: 0 };
      vmap[v.vertical].count++;
    }

    res.json({
      kpis: {
        total: totalTickets,
        open: buckets.open,
        pending: buckets.pending,
        resolved: buckets.resolved,
        closed: buckets.closed,
        unresolved: buckets.open + buckets.pending,
        today: todayCount,
        last7d: weekCount,
        assigned: assignedCount,
        unassigned: totalTickets - assignedCount,
        openIncidents: ongoingIncidents.length,
        contactPending,
        contactTotal,
      },
      buckets,
      byStatus: STATUSES.map((s) => ({ status: s, count: statusMap[s] || 0 })).filter((x) => x.count > 0),
      byCategory: byCategory.map((c) => ({ category: c.category, count: c._count._all })).sort((a, b) => b.count - a.count),
      bySeverity: SEVERITIES.map((s) => ({ severity: s, count: (bySeverity.find((x) => x.severity === s)?._count._all) || 0 })),
      byVertical: Object.values(vmap).sort((a, b) => b.count - a.count),
      incidents: ongoingIncidents.map((i) => ({ id: i.id, service_id: i.service_id, service_name: i.service_name, title: i.title, severity: i.severity, started_at: i.started_at })),
      note: 'Support tickets are user-submitted bug reports (bug_report). Buckets: open→Open · in_progress→Pending · resolved→Resolved · wont_fix/duplicate→Closed. There is no separate helpdesk/ticketing engine — this is a triage view over the platform\'s real inbound signals.',
    });
  } catch (err) {
    console.error('[board-admin/customer-support] overview error:', err);
    res.status(500).json({ successful: false, message: 'Could not load support overview' });
  }
});

// ─── TICKETS (the workhorse — bug_report feed) ───────────────────────────────────
router.get('/tickets', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
    const offset = (page - 1) * limit;

    const where = {};
    // exact status, OR a bucket (one or more statuses)
    if (req.query.status && STATUSES.includes(req.query.status)) {
      where.status = req.query.status;
    } else if (req.query.bucket && BUCKET_STATUSES[req.query.bucket]) {
      where.status = { in: BUCKET_STATUSES[req.query.bucket] };
    }
    if (req.query.category) where.category = req.query.category;
    if (req.query.severity && SEVERITIES.includes(req.query.severity)) where.severity = req.query.severity;
    if (req.query.priority === 'true') where.severity = { in: ['high', 'critical'] };
    // hasAttachment = tickets that carry at least one screenshot (bug_report_screenshot)
    if (req.query.hasAttachment === 'true') where.screenshots = { some: {} };
    // assigned = has a triage admin_note (the only assignment proxy we have)
    if (req.query.assigned === 'true') where.admin_note = { not: null };
    if (req.query.assigned === 'false') where.admin_note = null;
    if (req.query.search && req.query.search.trim()) {
      const q = req.query.search.trim();
      where.OR = [
        { title: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
      ];
    }
    // vertical filter via page_url heuristic (ILIKE any of the vertical's keywords)
    const vRule = VERTICAL_RULES.find((r) => r.vertical === req.query.vertical);
    if (vRule) {
      where.OR = (where.OR || []).concat(vRule.keywords.map((k) => ({ page_url: { contains: k, mode: 'insensitive' } })));
    }

    const [rows, total] = await Promise.all([
      prisma.bug_report.findMany({
        where,
        orderBy: [{ created_at: 'desc' }],
        skip: offset, take: limit,
        include: { _count: { select: { screenshots: true } } },
      }),
      prisma.bug_report.count({ where }),
    ]);

    const users = await userSummaries(rows.map((r) => r.user_id));
    const tickets = rows.map((r) => normalizeTicket(r, users));

    res.json({
      tickets,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
      filters: {
        status: where.status || null,
        category: req.query.category || null,
        severity: req.query.severity || null,
        bucket: req.query.bucket || null,
        assigned: req.query.assigned || null,
        priority: req.query.priority || null,
        hasAttachment: req.query.hasAttachment || null,
        vertical: req.query.vertical || null,
        search: req.query.search || null,
      },
      note: 'User-submitted bug reports, reframed as support tickets. Read-only — triage writes (status/note) happen in the Engineering dashboard\'s Bug Tracker. "Assigned" is derived from the presence of a triage note, not a real assignment engine.',
    });
  } catch (err) {
    console.error('[board-admin/customer-support] tickets error:', err);
    res.status(500).json({ successful: false, message: 'Could not load tickets' });
  }
});

// ─── INBOX (contact_submissions) ─────────────────────────────────────────────────
router.get('/inbox', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
    const offset = (page - 1) * limit;

    const where = {};
    if (req.query.status) where.status = req.query.status;
    if (req.query.search && req.query.search.trim()) {
      const q = req.query.search.trim();
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { subject: { contains: q, mode: 'insensitive' } },
        { message: { contains: q, mode: 'insensitive' } },
      ];
    }

    const [rows, total, byStatus, pendingCount] = await Promise.all([
      prisma.contact_submissions.findMany({ where, orderBy: [{ submitted_at: 'desc' }], skip: offset, take: limit }),
      prisma.contact_submissions.count({ where }),
      prisma.contact_submissions.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.contact_submissions.count({ where: { status: 'pending' } }),
    ]);

    res.json({
      messages: rows.map((m) => ({
        id: m.id,
        name: m.name,
        email: m.email, // contact form email is plaintext (public form), not encrypted
        subject: m.subject,
        message: m.message,
        status: m.status,
        submitted_at: m.submitted_at,
      })),
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
      byStatus: byStatus.map((s) => ({ status: s.status || 'pending', count: s._count._all })),
      pendingCount,
      note: 'Inbound messages from the public contact form (contact_submissions → Resend email). This is the only inbound support channel — there is no live chat, SMS or phone system.',
    });
  } catch (err) {
    console.error('[board-admin/customer-support] inbox error:', err);
    res.status(500).json({ successful: false, message: 'Could not load support inbox' });
  }
});

// ─── INCIDENTS (status_incident, mirrors the Engineering status board) ────────────
router.get('/incidents', async (_req, res) => {
  try {
    const [ongoing, recent] = await Promise.all([
      prisma.status_incident.findMany({ where: { status: 'ongoing' }, orderBy: { started_at: 'desc' } }),
      prisma.status_incident.findMany({ orderBy: { started_at: 'desc' }, take: 100 }),
    ]);
    const services = summarizeServices(STATUS_SERVICES, ongoing, { includeSummary: true });
    const counts = {
      ongoing: ongoing.length,
      bySeverity: { degraded: 0, down: 0 },
      byService: Object.fromEntries(STATUS_SERVICES.map((s) => [s.id, 0])),
    };
    for (const i of ongoing) {
      if (counts.bySeverity[i.severity] != null) counts.bySeverity[i.severity]++;
      if (counts.byService[i.service_id] != null) counts.byService[i.service_id]++;
    }
    res.json({
      overall: overallStatus(services),
      services: STATUS_SERVICES,
      serviceStatus: services,
      ongoing,
      recent,
      counts,
      updated_at: new Date(),
      note: 'Platform incidents from the status board (status_incident). The same store powers strug.ca/status and the Engineering / Operations dashboards. Read-only here — declaring/resolving incidents is done in the Engineering dashboard.',
    });
  } catch (err) {
    console.error('[board-admin/customer-support] incidents error:', err);
    res.status(500).json({ successful: false, message: 'Could not load incidents' });
  }
});

// ─── ANALYTICS (volume + category + resolution time) ─────────────────────────────
router.get('/analytics', async (req, res) => {
  try {
    const days = clampInt(req.query.days, 7, 365, 90);
    const cutoff = new Date(Date.now() - days * 86400000);

    const [daily, byCategory, bySeverity, byStatus, resolution, catByDay] = await Promise.all([
      // daily inbound ticket volume
      prisma.$queryRaw`
        SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS date, COUNT(*)::int AS tickets
        FROM bug_report WHERE created_at >= ${cutoff} GROUP BY 1 ORDER BY 1`,
      prisma.bug_report.groupBy({ by: ['category'], _count: { _all: true }, where: { created_at: { gte: cutoff } } }),
      prisma.bug_report.groupBy({ by: ['severity'], _count: { _all: true }, where: { created_at: { gte: cutoff } } }),
      prisma.bug_report.groupBy({ by: ['status'], _count: { _all: true }, where: { created_at: { gte: cutoff } } }),
      // resolution time on resolved rows: updated_at − created_at (no transition log exists,
      // so this is created→last-update for resolved tickets — the closest honest proxy).
      prisma.$queryRaw`
        SELECT COUNT(*)::int AS resolved,
               AVG(EXTRACT(EPOCH FROM (updated_at - created_at)))::float AS avg_seconds,
               MIN(EXTRACT(EPOCH FROM (updated_at - created_at)))::float AS min_seconds,
               MAX(EXTRACT(EPOCH FROM (updated_at - created_at)))::float AS max_seconds,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (updated_at - created_at)))::float AS median_seconds
        FROM bug_report WHERE status = 'resolved' AND created_at >= ${cutoff}`,
      // category trend: per-day, per-category counts (for the stacked category-trends view)
      prisma.$queryRaw`
        SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS date, category, COUNT(*)::int AS tickets
        FROM bug_report WHERE created_at >= ${cutoff} GROUP BY 1, 2 ORDER BY 1`,
    ]);

    const r = resolution[0] || {};
    res.json({
      days,
      daily, // [{ date, tickets }]
      byCategory: byCategory.map((c) => ({ category: c.category, count: c._count._all })).sort((a, b) => b.count - a.count),
      bySeverity: SEVERITIES.map((s) => ({ severity: s, count: (bySeverity.find((x) => x.severity === s)?._count._all) || 0 })),
      byStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all })),
      resolution: {
        resolved: num(r.resolved),
        avgSeconds: num(r.avg_seconds),
        medianSeconds: num(r.median_seconds),
        minSeconds: num(r.min_seconds),
        maxSeconds: num(r.max_seconds),
      },
      categoryByDay: catByDay, // [{ date, category, tickets }]
      note: 'Ticket analytics from bug_report. Resolution time = updated_at − created_at on resolved tickets (no first-response timestamp or status-transition log exists, so first-response time and reopen rate aren\'t derivable).',
    });
  } catch (err) {
    console.error('[board-admin/customer-support] analytics error:', err);
    res.status(500).json({ successful: false, message: 'Could not load support analytics' });
  }
});

// ─── ACCOUNTS (account_status populations — appeals/recovery context) ─────────────
// READ-ONLY context for the Suspension Appeals / Ban Appeals / Account Recovery
// sections. There is NO appeals store — these are simply the users currently in each
// account_status, with the reason/when. The dashboard is explicit that this is "who is
// suspended/banned", not a queue of appeal requests.
const ACCOUNT_STATUSES = ['suspended', 'banned', 'restricted'];
router.get('/accounts', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
    const offset = (page - 1) * limit;
    const status = ACCOUNT_STATUSES.includes(req.query.status) ? req.query.status : 'suspended';

    const where = { account_status: status };
    const [rows, total, counts] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          user_id: true, name: true, username: true, email: true, country: true,
          account_status: true, status_reason: true, status_changed_at: true, status_changed_by: true,
          social_profiles: { select: { display_name: true, handle: true } },
        },
        orderBy: [{ status_changed_at: 'desc' }],
        skip: offset, take: limit,
      }),
      prisma.user.count({ where }),
      prisma.user.groupBy({ by: ['account_status'], _count: { _all: true }, where: { account_status: { in: ACCOUNT_STATUSES } } }),
    ]);

    res.json({
      status,
      accounts: rows.map((u) => ({
        user_id: u.user_id,
        name: u.name,
        username: u.username,
        email: decryptEmail(u.email),
        country: u.country,
        display_name: u.social_profiles?.display_name || null,
        handle: u.social_profiles?.handle || null,
        account_status: u.account_status,
        status_reason: u.status_reason,
        status_changed_at: u.status_changed_at,
        status_changed_by: u.status_changed_by,
      })),
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
      counts: Object.fromEntries(ACCOUNT_STATUSES.map((s) => [s, (counts.find((c) => c.account_status === s)?._count._all) || 0])),
      note: 'Read-only account-status context. There is NO appeals/recovery request store — this lists the users currently suspended / banned / restricted (with reason + when), not a queue of appeals. Status changes are applied from the User Management dashboard.',
    });
  } catch (err) {
    console.error('[board-admin/customer-support] accounts error:', err);
    res.status(500).json({ successful: false, message: 'Could not load account-status context' });
  }
});

export default router;
