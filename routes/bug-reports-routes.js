// routes/bug-reports-routes.js
//
// User-submitted bug reports / issue tickets.
//   POST   /bug-reports/submit             (auth)      create a report (+ up to 3 screenshots)
//   GET    /bug-reports/public             (public)    curated list for strug.ca/bug-reports
//   GET    /bug-reports/mine               (auth)      the caller's own reports + their threads
//   POST   /bug-reports/mine/:id/messages  (auth)      the reporter ANSWERS a board question
//   GET    /bug-reports/admin              (admin)     full list with all fields + screenshots
//   PATCH  /bug-reports/admin/:id          (admin)     triage: status / severity / is_public / note
//   POST   /bug-reports/admin/:id/messages (admin)     the board ASKS the reporter a question
//
// The public endpoint deliberately exposes only non-sensitive fields and only rows an
// admin has flipped to is_public — raw descriptions, emails and reporter identity are
// never returned to anonymous callers. The thread and the auto-captured client_context are
// likewise NEVER public: see PUBLIC_SELECT and MINE_SELECT, which are explicit allow-lists.
//
// ── The follow-up loop (2026-07-15) ──────────────────────────────────────────────────────
// Board asks  → bug_report_message(author_type='board')   → status = 'awaiting_reporter'
//             → notify() rings the reporter's bell (+ email fallback)
// Reporter answers → bug_report_message(author_type='reporter') → status back to 'open'
//             → the board is emailed, and the ticket shows `awaiting_board`
// The reporter answers as a NORMAL APP USER — no board login. See routes below.

import express from 'express';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { authenticateBoard } from '../middleware/authenticate-board.js';
import { uploadPublicBlob } from '../utils/azure-storage.js';
import { notifyNewBugReport, notifyReporterQuestion, notifyBoardReply } from '../utils/bug-report-notify.js';
import { sanitizeClientContext, stripUrlParams } from '../utils/bug-report-context.js';
import { notify } from '../services/notify.js';

const router = express.Router();

// Triage gate for the bug-report admin endpoints. As of the Task Board (M5) the bug
// panel is owned by the board team: access requires a board member who can_assign OR
// can_review (Codezero + the senior dev) — the shared "Admin123!" password gate is gone.
// A platform-admin JWT (separate `admin` table) is still accepted, since requireAdmin
// backs broader platform admin and that concern is deliberately left untouched.
function bugAdminAuth(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ successful: false, message: 'Access denied' });

    let payload;
    try {
        payload = jwt.verify(token, process.env.ACCESS_TOKEN_KEY);
    } catch {
        return res.status(401).json({ successful: false, message: 'Invalid token' });
    }

    if (payload?.permission === 'board') {
        // Load + validate the board member (approved, capability flags) then require triage rights.
        return authenticateBoard(req, res, () => {
            if (req.member?.can_assign || req.member?.can_review) return next();
            return res.status(403).json({ successful: false, message: 'Forbidden: board reviewer or supervisor only' });
        });
    }

    // Legacy platform admin (separate `admin` table) retains access.
    return authenticateToken(req, res, () => requireAdmin(req, res, next));
}

const SCREENSHOT_CONTAINER = process.env.AZURE_BUG_REPORTS_CONTAINER || 'bug-report-screenshots';
const MAX_SCREENSHOTS = 3;

// Images only, 5 MB each — screenshots, not media uploads.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
            return cb(new Error('Only image files are allowed for screenshots'));
        }
        cb(null, true);
    },
});

// Wrap multer so its errors become clean 4xx JSON instead of a generic 500.
const uploadScreenshots = (req, res, next) => {
    upload.array('screenshots', MAX_SCREENSHOTS)(req, res, (err) => {
        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(413).json({ successful: false, message: 'Each screenshot must be under 5MB' });
            }
            if (err.code === 'LIMIT_UNEXPECTED_FILE') {
                return res.status(400).json({ successful: false, message: `At most ${MAX_SCREENSHOTS} screenshots allowed` });
            }
            return res.status(400).json({ successful: false, message: err.message });
        }
        if (err) return res.status(400).json({ successful: false, message: err.message });
        next();
    });
};

// 'feature' lets the same intake double as a feature-suggestion channel (Codezero +
// users); the board treats category==='feature' as a suggestion, separate from bugs.
// 'driver_support' reuses this same intake for the driver-app self-service support flow
// (routes/driver-safety-routes.js's sibling on the frontend, DriverSupportSection) — same
// model, same board queue, filterable by category rather than a parallel ticket system.
const CATEGORIES = ['bug', 'ui', 'performance', 'account', 'other', 'feature', 'driver_support'];
const SEVERITIES = ['low', 'medium', 'high', 'critical'];
// 'awaiting_reporter' = the board asked a question and is blocked on the reporter. It is a
// distinct status (not just a flag on `open`) so a blocked ticket doesn't read as idle triage.
const STATUSES = ['open', 'in_progress', 'awaiting_reporter', 'resolved', 'wont_fix', 'duplicate'];

const submitSchema = z.object({
    title: z.string().trim().min(4, 'Title is too short').max(255),
    description: z.string().trim().min(10, 'Please describe the issue in a bit more detail').max(5000),
    category: z.enum(CATEGORIES).default('bug'),
    severity: z.enum(SEVERITIES).default('medium'),
    page_url: z.string().trim().max(1000).optional(),
    // Auto-captured diagnostics, JSON-encoded (the request is multipart, so it arrives as a
    // string). Never trusted: sanitizeClientContext() re-validates and re-redacts everything.
    // Deliberately lenient — a bad blob must never cost the user the report they just typed.
    client_context: z.string().max(32_000).optional(),
});

const adminUpdateSchema = z.object({
    status: z.enum(STATUSES).optional(),
    severity: z.enum(SEVERITIES).optional(),
    category: z.enum(CATEGORIES).optional(), // allow re-classifying a report (e.g. bug → feature)
    is_public: z.coerce.boolean().optional(),
    admin_note: z.string().trim().max(5000).optional(),
}).refine((d) => Object.keys(d).length > 0, { message: 'No fields to update' });

const messageSchema = z.object({
    body: z.string().trim().min(1, 'Message cannot be empty').max(5000),
});

// ── Thread ────────────────────────────────────────────────────────────────────────────────
// ONE serializer, used by every endpoint that ever returns a message — the POST echo and the
// GET list both go through it. That is deliberate: the #462 root cause was a POST echo whose
// field names drifted from the GET list, so a just-created row rendered differently from a
// refetched one. If you add a field, add it HERE and both sides get it.
const MESSAGE_SELECT = {
    message_id: true,
    bug_report_id: true,
    author_type: true,
    author_name: true,
    author_user_id: true,
    body: true,
    created_at: true,
};

const MESSAGE_INCLUDE = { select: MESSAGE_SELECT, orderBy: { created_at: 'asc' } };

function serializeMessage(m) {
    if (!m) return null;
    return {
        message_id: m.message_id,
        bug_report_id: m.bug_report_id,
        author_type: m.author_type,                       // 'board' | 'reporter'
        author_name: m.author_name || (m.author_type === 'board' ? 'Strug team' : 'You'),
        author_user_id: m.author_user_id ?? null,
        body: m.body,
        created_at: m.created_at,
    };
}

// Derived, never stored: the last word is the reporter's ⇒ the board owes a response. Deriving
// it (rather than keeping an `unread` column) means it can never drift out of sync with the
// thread it describes.
function awaitingBoard(messages) {
    if (!messages?.length) return false;
    return messages[messages.length - 1].author_type === 'reporter';
}

// Reduce the raw User-Agent header to a non-fingerprinting "Browser · OS" summary
// for admin debugging — we never store the full UA string (privacy hygiene).
function simplifyUserAgent(raw) {
    const ua = String(raw || '');
    if (!ua) return null;

    let os = 'Unknown OS';
    if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
    else if (/Android/.test(ua)) os = 'Android';
    else if (/Windows/.test(ua)) os = 'Windows';
    else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS';
    else if (/CrOS/.test(ua)) os = 'ChromeOS';
    else if (/Linux/.test(ua)) os = 'Linux';

    let browser = 'Unknown browser';
    let m;
    if ((m = ua.match(/Edg(?:e|A|iOS)?\/(\d+)/))) browser = `Edge ${m[1]}`;
    else if ((m = ua.match(/(?:OPR|Opera)\/(\d+)/))) browser = `Opera ${m[1]}`;
    else if ((m = ua.match(/SamsungBrowser\/(\d+)/))) browser = `Samsung Internet ${m[1]}`;
    else if ((m = ua.match(/Firefox\/(\d+)/))) browser = `Firefox ${m[1]}`;
    else if ((m = ua.match(/Chrome\/(\d+)/))) browser = `Chrome ${m[1]}`;
    else if ((m = ua.match(/Version\/(\d+)[\d.]*\s+(?:Mobile\/\S+\s+)?Safari/))) browser = `Safari ${m[1]}`;
    else if (/Safari/.test(ua)) browser = 'Safari';

    return `${browser} · ${os}`;
}

/**
 * POST /bug-reports/submit — authenticated users only.
 */
router.post('/submit', authenticateToken, uploadScreenshots, async (req, res) => {
    try {
        const validated = submitSchema.safeParse(req.body);
        if (!validated.success) {
            return res.status(400).json({ successful: false, errors: (validated.error.issues ?? validated.error.errors) });
        }
        const { title, description, category, severity, page_url, client_context } = validated.data;
        const user_id = req.user?.user_id ?? null;

        // Auto-captured context. This is the half of the feature that stops most follow-up
        // questions from ever needing to be asked. Strictly sanitised — no headers, no tokens,
        // no request bodies (utils/bug-report-context.js).
        const captured = sanitizeClientContext(client_context);

        // Snapshot the reporter's email for admin follow-up (best-effort).
        let email = null;
        let reporterLabel = null;
        try {
            const account = await prisma.user.findUnique({ where: { user_id }, select: { email: true, username: true } });
            email = account?.email ?? null;
            if (account?.username) reporterLabel = `@${account.username}`;
        } catch { /* non-fatal */ }

        // Upload screenshots to Azure (public-read blob container).
        let screenshots = [];
        if (req.files && req.files.length > 0) {
            screenshots = await Promise.all(req.files.map(async (file, i) => {
                const ext = (file.mimetype.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
                const url = await uploadPublicBlob(
                    SCREENSHOT_CONTAINER,
                    `${user_id || 'anon'}-${Date.now()}-${i}.${ext}`,
                    file.buffer,
                    file.mimetype,
                );
                return { screenshot_url: url, sequence_order: i + 1 };
            }));
        }

        const userAgent = simplifyUserAgent(req.headers['user-agent']);

        const report = await prisma.bug_report.create({
            data: {
                user_id,
                email,
                title,
                description,
                category,
                severity,
                // Scrub query params: page_url is window.location.href verbatim, and our own
                // tooling authenticates with `?token=…&user=…`. A reporter filing from such a
                // URL would otherwise persist a live access token into a board-readable row.
                page_url: stripUrlParams(page_url),
                user_agent: userAgent || null,
                build_sha: captured.build_sha,
                viewport: captured.viewport,
                device_type: captured.device_type,
                nav_id: captured.nav_id,
                client_context: captured.context ?? undefined,
                screenshots: screenshots.length ? { create: screenshots } : undefined,
            },
            include: { screenshots: true },
        });

        // Fire-and-forget admin alert (email via Resend). notifyNewBugReport never throws and
        // we deliberately don't await it, so a slow/failed email can't delay or break the
        // reporter's 201. Recipients + on/off are controlled by the BUG_ALERT_EMAIL env var.
        notifyNewBugReport({ ...report, reporter_label: reporterLabel });

        return res.status(201).json({
            successful: true,
            message: 'Thanks — your report was submitted.',
            data: { bug_report_id: report.bug_report_id, status: report.status, created_at: report.created_at },
        });
    } catch (err) {
        console.error('Bug report submit error:', err);
        return res.status(500).json({ successful: false, message: 'Could not submit bug report' });
    }
});

/**
 * GET /bug-reports/public — curated, non-sensitive fields for the public board.
 * Only rows an admin has marked is_public are returned.
 *
 * The select below is an ALLOW-LIST and must stay one. Marking a report public must never
 * expose: description, email, reporter identity, admin_note, the reporter↔board thread, or
 * client_context (which can carry console text). Adding a field here is a privacy decision,
 * not a formatting one. Guarded by test/integration/bug-report-privacy.test.js.
 */
router.get('/public', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 100, 200);
        const reports = await prisma.bug_report.findMany({
            where: { is_public: true },
            select: {
                bug_report_id: true,
                title: true,
                category: true,
                status: true,
                severity: true,
                created_at: true,
                updated_at: true,
            },
            orderBy: [{ created_at: 'desc' }],
            take: limit,
        });
        res.set('Cache-Control', 'no-store');
        return res.json({ successful: true, count: reports.length, reports });
    } catch (err) {
        console.error('Bug report public list error:', err);
        return res.status(500).json({ successful: false, message: 'Could not load bug reports' });
    }
});

/**
 * GET /bug-reports/mine — the authenticated user's own submissions, WITH their threads.
 *
 * This is what the app's "My reports" page renders, and it's how a reporter sees a board
 * question and answers it without ever touching a board login.
 *
 * The select below is an explicit allow-list. `admin_note` (board-internal) and
 * `client_context` (can contain console text) are deliberately absent — a reporter sees their
 * own report and the conversation, never the triage notes about them.
 */
const MINE_SELECT = {
    bug_report_id: true,
    title: true,
    description: true,
    category: true,
    status: true,
    severity: true,
    is_public: true,
    page_url: true,
    created_at: true,
    updated_at: true,
    screenshots: { select: { screenshot_id: true, screenshot_url: true, sequence_order: true }, orderBy: { sequence_order: 'asc' } },
    messages: MESSAGE_INCLUDE,
};

function serializeMine(report) {
    const messages = (report.messages ?? []).map(serializeMessage);
    return {
        ...report,
        messages,
        // The reporter's cue to act. Mirrors the status, but exposed as a boolean so the UI
        // doesn't have to hardcode the status string.
        awaiting_you: report.status === 'awaiting_reporter',
    };
}

router.get('/mine', authenticateToken, async (req, res) => {
    try {
        const reports = await prisma.bug_report.findMany({
            where: { user_id: req.user.user_id },
            select: MINE_SELECT,
            orderBy: [{ created_at: 'desc' }],
        });
        return res.json({ successful: true, count: reports.length, reports: reports.map(serializeMine) });
    } catch (err) {
        console.error('Bug report mine error:', err);
        return res.status(500).json({ successful: false, message: 'Could not load your reports' });
    }
});

/**
 * POST /bug-reports/mine/:id/messages — the reporter ANSWERS a board question.
 *
 * Authed as a normal app user (NOT a board member) and hard-scoped to their own report: the
 * ownership check is part of the write itself, so there is no window where a wrong id could
 * append to someone else's thread.
 *
 * On an answer the ticket returns to `open` — an answered ticket genuinely needs a human to
 * look at it again, which is exactly what `open` means. The board sees it flagged
 * `awaiting_board` so a reply can't sink unnoticed into the open backlog.
 */
router.post('/mine/:id/messages', authenticateToken, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!id || Number.isNaN(id)) return res.status(400).json({ successful: false, message: 'Invalid id' });

        const validated = messageSchema.safeParse(req.body);
        if (!validated.success) {
            return res.status(400).json({ successful: false, errors: (validated.error.issues ?? validated.error.errors) });
        }

        const report = await prisma.bug_report.findUnique({ where: { bug_report_id: id } });
        if (!report) return res.status(404).json({ successful: false, message: 'Report not found' });
        // Same 404 for "not yours" as for "doesn't exist" — don't confirm the existence of
        // other people's reports to a probing caller.
        if (report.user_id !== req.user.user_id) {
            return res.status(404).json({ successful: false, message: 'Report not found' });
        }

        let authorName = null;
        try {
            const profile = await prisma.social_profile.findFirst({
                where: { user_id: req.user.user_id },
                select: { display_name: true, handle: true },
            });
            const account = await prisma.user.findUnique({
                where: { user_id: req.user.user_id },
                select: { username: true },
            });
            authorName = profile?.display_name || (profile?.handle && `@${profile.handle}`) || (account?.username && `@${account.username}`) || null;
        } catch (e) {
            // A missing display name must not cost us the answer — serializeMessage falls back.
            console.warn('[bug-reports] could not resolve reporter name:', e.message);
        }

        const message = await prisma.bug_report_message.create({
            data: {
                bug_report_id: id,
                author_type: 'reporter',
                author_user_id: req.user.user_id,
                author_name: authorName,
                body: validated.data.body,
            },
            select: MESSAGE_SELECT,
        });

        // Back into the actionable queue. Only lift it out of awaiting_reporter — if the board
        // has since resolved or closed the ticket, a late reply shouldn't silently reopen it.
        let status = report.status;
        if (report.status === 'awaiting_reporter') {
            const bumped = await prisma.bug_report.update({
                where: { bug_report_id: id },
                data: { status: 'open' },
                select: { status: true },
            });
            status = bumped.status;
        }

        // Tell the board. Fire-and-forget: never let a mail hiccup fail the reporter's answer.
        notifyBoardReply(report, validated.data.body, authorName);

        return res.status(201).json({
            successful: true,
            data: { message: serializeMessage(message), status, awaiting_you: status === 'awaiting_reporter' },
        });
    } catch (err) {
        console.error('Bug report reporter-message error:', err);
        return res.status(500).json({ successful: false, message: 'Could not send your reply' });
    }
});

// Admin queries also pull the reporter's social profile so the dashboard can show a real
// identity, plus the reporter↔board thread so the triage panel renders it without a 2nd call.
const ADMIN_REPORT_INCLUDE = {
    screenshots: { orderBy: { sequence_order: 'asc' } },
    messages: MESSAGE_INCLUDE,
    user: {
        select: {
            user_id: true,
            username: true,
            // `user.social_profiles` is a TO-ONE optional relation (social_profile?, with
            // user_id @unique) — it is NOT a list. See the fix in withReporter() below.
            social_profiles: { select: { handle: true, display_name: true } },
        },
    },
};

// Flatten the nested user relation into a compact `reporter` object and drop it,
// so the admin UI gets { handle, display_name, username, user_id } it can link to.
function withReporter(report) {
    // `social_profiles` is to-one, so it is an OBJECT (or null) — never an array. This used to
    // read `social_profiles?.[0]`, which indexes an object and is therefore ALWAYS undefined:
    // handle + display_name silently came back null on every card and the board fell through to
    // `@username`. That's why the triage panel never showed a usable reporter identity.
    const profile = report.user?.social_profiles ?? null;
    const reporter = report.user
        ? {
            user_id: report.user.user_id,
            handle: profile?.handle ?? null,
            display_name: profile?.display_name ?? null,
            username: report.user.username ?? null,
        }
        : null;
    const messages = (report.messages ?? []).map(serializeMessage);
    const { user, ...rest } = report;
    return {
        ...rest,
        reporter,
        messages,
        // The reporter has answered and nobody has picked it back up.
        awaiting_board: awaitingBoard(messages),
    };
}

/**
 * GET /bug-reports/admin — full triage view. Optional ?status= filter.
 */
router.get('/admin', bugAdminAuth, async (req, res) => {
    const where = {};
    if (req.query.status && STATUSES.includes(req.query.status)) where.status = req.query.status;
    // Admin triage shows the FULL list — no cap, otherwise the open backlog (newest-first)
    // starves resolved/older reports out of the default view. `?limit=` stays as an
    // optional override for callers that want a smaller page.
    const parsedLimit = parseInt(req.query.limit, 10);
    const take = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : undefined;
    const orderBy = [{ created_at: 'desc' }];
    try {
        const reports = await prisma.bug_report.findMany({ where, include: ADMIN_REPORT_INCLUDE, orderBy, take });
        return res.json({ successful: true, count: reports.length, reports: reports.map(withReporter) });
    } catch (err) {
        // The reporter include has 500'd on prod for reasons that don't reproduce
        // locally. Don't let that take the whole triage board down — fall back to
        // the bare reports (no reporter identity) so admins can still load + triage.
        console.error('Bug report admin list error (with reporter include):', err?.code, err?.message);
        try {
            const reports = await prisma.bug_report.findMany({ where, orderBy, take });
            return res.json({ successful: true, count: reports.length, reports: reports.map(r => ({ ...r, reporter: null })) });
        } catch (err2) {
            console.error('Bug report admin list error (bare fallback):', err2?.code, err2?.message);
            return res.status(500).json({ successful: false, message: 'Could not load bug reports' });
        }
    }
});

/**
 * PATCH /bug-reports/admin/:id — update triage fields.
 */
router.patch('/admin/:id', bugAdminAuth, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!id || Number.isNaN(id)) return res.status(400).json({ successful: false, message: 'Invalid id' });

        const validated = adminUpdateSchema.safeParse(req.body);
        if (!validated.success) {
            return res.status(400).json({ successful: false, errors: (validated.error.issues ?? validated.error.errors) });
        }

        // Commit the triage change WITHOUT the reporter include, so the write
        // always lands even if enriching the response later fails (the include
        // has been 500'ing on prod). Then best-effort enrich for the response.
        const updated = await prisma.bug_report.update({
            where: { bug_report_id: id },
            data: validated.data,
        });
        try {
            const full = await prisma.bug_report.findUnique({
                where: { bug_report_id: id },
                include: ADMIN_REPORT_INCLUDE,
            });
            return res.json({ successful: true, data: withReporter(full) });
        } catch (enrichErr) {
            console.error('Bug report admin update enrich error:', enrichErr?.code, enrichErr?.message);
            return res.json({ successful: true, data: { ...updated, reporter: null } });
        }
    } catch (err) {
        if (err.code === 'P2025') return res.status(404).json({ successful: false, message: 'Report not found' });
        console.error('Bug report admin update error:', err);
        return res.status(500).json({ successful: false, message: 'Could not update bug report' });
    }
});

/**
 * POST /bug-reports/admin/:id/messages — the board ASKS the reporter a follow-up question.
 *
 * This is the endpoint that exists because of #462: a ticket got resolved on a plausible
 * theory because there was no way to ask the reporter "which account? which page? does it
 * survive a hard refresh?".
 *
 * Asking moves the ticket to `awaiting_reporter` so it stops looking like idle triage work,
 * and reaches the reporter on two channels:
 *   1. in-app notification (primary) — durable, rings the bell, deep-links to 'my-reports'
 *   2. email (fallback) — for a reporter who isn't in the app right now
 * Both are best-effort. Neither may fail the question that was just asked.
 */
router.post('/admin/:id/messages', bugAdminAuth, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!id || Number.isNaN(id)) return res.status(400).json({ successful: false, message: 'Invalid id' });

        const validated = messageSchema.safeParse(req.body);
        if (!validated.success) {
            return res.status(400).json({ successful: false, errors: (validated.error.issues ?? validated.error.errors) });
        }

        const report = await prisma.bug_report.findUnique({ where: { bug_report_id: id } });
        if (!report) return res.status(404).json({ successful: false, message: 'Report not found' });

        // An anonymous/orphaned report has nobody to ask. Say so plainly rather than writing a
        // question into a thread that will never be read.
        if (!report.user_id) {
            return res.status(409).json({
                successful: false,
                message: 'This report has no linked account, so the reporter cannot be reached.',
            });
        }

        // bugAdminAuth admits either a board member (req.member) or a legacy platform admin.
        const askerName = req.member?.name || 'Strug team';
        const askerId = req.member?.member_id ?? null;

        const message = await prisma.bug_report_message.create({
            data: {
                bug_report_id: id,
                author_type: 'board',
                author_member_id: askerId,
                author_name: askerName,
                body: validated.data.body,
            },
            select: MESSAGE_SELECT,
        });

        // Blocked on the reporter — distinct from open/in_progress.
        const updated = await prisma.bug_report.update({
            where: { bug_report_id: id },
            data: { status: 'awaiting_reporter' },
            select: { status: true },
        });

        // (1) In-app. `vertical: 'system'` is an existing key in notify.js's push-category map,
        // so no new push category is needed. `actionUrl` MUST be a bare SPA nav id — the panel
        // feeds it straight into setActiveNav; a path like '/my-reports/12' would set a bogus
        // nav id and land the user nowhere.
        notify(req.app.get('io'), {
            userId: report.user_id,
            vertical: 'system',
            type: 'bug.question',
            urgency: 'actionable',
            title: 'We need a bit more info',
            body: `${askerName} asked a question about your report: "${report.title}"`,
            entityType: 'bug_report',
            entityId: id,
            actionUrl: 'my-reports',
        }).catch((e) => console.error('[bug-reports] notify failed:', e.message));

        // (2) Email fallback. Prefer the account's CURRENT address over the snapshot taken at
        // submit time — the snapshot can be months stale if they've since changed it.
        (async () => {
            try {
                const account = await prisma.user.findUnique({
                    where: { user_id: report.user_id },
                    select: { email: true },
                });
                const to = account?.email || report.email;
                if (to) await notifyReporterQuestion(report, to, validated.data.body, askerName);
                else console.warn(`[bug-reports] no email on file for reporter of #${id}; in-app only`);
            } catch (e) {
                console.error('[bug-reports] reporter email lookup failed:', e.message);
            }
        })();

        return res.status(201).json({
            successful: true,
            data: { message: serializeMessage(message), status: updated.status, awaiting_board: false },
        });
    } catch (err) {
        console.error('Bug report board-message error:', err);
        return res.status(500).json({ successful: false, message: 'Could not send the question' });
    }
});

export default router;
