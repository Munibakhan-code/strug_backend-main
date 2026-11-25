import express from 'express';
import prisma from '../utils/prisma-client.js';
import { authenticateToken } from '../middleware/authentication.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { authenticateBoard } from '../middleware/authenticate-board.js';

const router = express.Router();

// Services shown on the status page. `operational` means "no active incident" — absence of a
// signal, the standard status-page convention. Today only `video` is fed by an automated monitor
// (utils/video-pipeline-monitor.js writes status_incident rows); the rest read operational unless
// something opens an incident for them, and can be wired to their own monitors later.
export const STATUS_SERVICES = [
    { id: 'video', name: 'Video playback' },
    { id: 'live', name: 'Live streaming' },
    { id: 'payments', name: 'Payments' },
    { id: 'api', name: 'Core API' },
];

const SEVERITY_RANK = { operational: 0, degraded: 1, down: 2 };

// Pure: fold the ongoing incidents onto the service registry. Each service's status is the worst
// severity among its ongoing incidents (else operational). `includeSummary` gates the internal
// reason text so the public view never leaks "reconciliation sweep stale" etc. Exported for tests.
export function summarizeServices(services, ongoing, { includeSummary = false } = {}) {
    return services.map((s) => {
        const incidents = ongoing.filter((i) => i.service_id === s.id);
        let status = 'operational';
        for (const i of incidents) {
            if ((SEVERITY_RANK[i.severity] ?? 1) > (SEVERITY_RANK[status] ?? 0)) status = i.severity;
        }
        return {
            id: s.id,
            name: s.name,
            status,
            incidents: incidents.map((i) => ({
                id: i.id,
                title: i.title,
                severity: i.severity,
                status: i.status,
                started_at: i.started_at,
                resolved_at: i.resolved_at,
                ...(includeSummary ? { summary: i.summary } : {}),
            })),
        };
    });
}

// Pure: overall banner = worst service status. Exported for tests.
export function overallStatus(services) {
    let overall = 'operational';
    for (const s of services) {
        if ((SEVERITY_RANK[s.status] ?? 0) > (SEVERITY_RANK[overall] ?? 0)) overall = s.status;
    }
    return overall;
}

// PUBLIC — friendly service lines only, no internal reason text. Safe to render at strug.ca/status.
router.get('/summary', async (_req, res) => {
    try {
        const ongoing = await prisma.status_incident.findMany({
            where: { status: 'ongoing' },
            orderBy: { started_at: 'desc' },
        });
        const services = summarizeServices(STATUS_SERVICES, ongoing, { includeSummary: false });
        res.json({ successful: true, overall: overallStatus(services), services, updated_at: new Date() });
    } catch (err) {
        console.error('[status] summary failed:', err.message);
        res.status(500).json({ successful: false, message: 'Could not load status' });
    }
});

// INTERNAL — admin only. Adds the technical `summary` on each ongoing incident plus recent history.
router.get('/detail', authenticateToken, requireAdmin, async (_req, res) => {
    try {
        const [ongoing, recent] = await Promise.all([
            prisma.status_incident.findMany({ where: { status: 'ongoing' }, orderBy: { started_at: 'desc' } }),
            prisma.status_incident.findMany({ orderBy: { started_at: 'desc' }, take: 50 }),
        ]);
        const services = summarizeServices(STATUS_SERVICES, ongoing, { includeSummary: true });
        res.json({ successful: true, overall: overallStatus(services), services, recent });
    } catch (err) {
        console.error('[status] detail failed:', err.message);
        res.status(500).json({ successful: false, message: 'Could not load status detail' });
    }
});

// ─── BOARD (internal dashboards: Engineering › Incidents/Status) ──────────────
// Same shape as /detail, but gated by the board identity (the internal dashboards
// authenticate as board_member, not the platform `admin` JWT) instead of requireAdmin.
// Reads are open to any approved board member; writes (create/resolve a MANUAL
// incident) require can_assign OR can_review — the same triage tier as the bug board.

const SERVICE_BY_ID = new Map(STATUS_SERVICES.map((s) => [s.id, s]));
const VALID_SEVERITY = new Set(['degraded', 'down']); // 'operational' is the absence of an incident

// Write gate — run AFTER authenticateBoard. Manual incident create/resolve is a triage action.
function requireIncidentWrite(req, res, next) {
    if (req.member?.can_assign || req.member?.can_review) return next();
    return res.status(403).json({ successful: false, message: 'Forbidden: board reviewer or supervisor only' });
}

// READ — services folded over ongoing incidents (with internal summary), recent history,
// and counts for the dashboard stat rail. Board members are authorized to see reason text.
router.get('/board', authenticateBoard, async (_req, res) => {
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
            successful: true,
            overall: overallStatus(services),
            services: STATUS_SERVICES, // registry (id+name) so the UI can render manual-incident pickers
            serviceStatus: services,
            recent,
            counts,
            updated_at: new Date(),
        });
    } catch (err) {
        console.error('[status] board read failed:', err.message);
        res.status(500).json({ successful: false, message: 'Could not load status' });
    }
});

// CREATE — a MANUAL incident (auto:false). For services with no automated monitor
// (live / payments / api) this is how an operator declares an incident. The video
// monitor owns its own (auto:true) rows; we never create those here.
router.post('/board', authenticateBoard, requireIncidentWrite, async (req, res) => {
    try {
        const { service_id, title, severity = 'down', summary } = req.body || {};
        const service = SERVICE_BY_ID.get(service_id);
        if (!service) {
            return res.status(400).json({ successful: false, message: 'Unknown service_id' });
        }
        if (!title || !String(title).trim()) {
            return res.status(400).json({ successful: false, message: 'Title is required' });
        }
        if (!VALID_SEVERITY.has(severity)) {
            return res.status(400).json({ successful: false, message: 'Severity must be degraded or down' });
        }
        const incident = await prisma.status_incident.create({
            data: {
                service_id: service.id,
                service_name: service.name,
                title: String(title).trim().slice(0, 255),
                severity,
                status: 'ongoing',
                summary: summary ? String(summary).slice(0, 2000) : null,
                auto: false,
            },
        });
        res.status(201).json({ successful: true, incident });
    } catch (err) {
        console.error('[status] board create failed:', err.message);
        res.status(500).json({ successful: false, message: 'Could not create incident' });
    }
});

// RESOLVE / REOPEN — MANUAL incidents only. Auto (monitor-owned) incidents are left
// to the monitor: a human "resolve" would just be re-opened on the next sweep if the
// underlying signal is still bad, so we 409 rather than create flapping.
router.patch('/board/:id', authenticateBoard, requireIncidentWrite, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isInteger(id)) {
            return res.status(400).json({ successful: false, message: 'Invalid incident id' });
        }
        const { status } = req.body || {};
        if (status !== 'resolved' && status !== 'ongoing') {
            return res.status(400).json({ successful: false, message: 'status must be resolved or ongoing' });
        }
        const existing = await prisma.status_incident.findUnique({ where: { id } });
        if (!existing) return res.status(404).json({ successful: false, message: 'Incident not found' });
        if (existing.auto) {
            return res.status(409).json({ successful: false, message: 'Automated incidents are managed by the monitor and cannot be triaged manually' });
        }
        const incident = await prisma.status_incident.update({
            where: { id },
            data: { status, resolved_at: status === 'resolved' ? new Date() : null },
        });
        res.json({ successful: true, incident });
    } catch (err) {
        console.error('[status] board patch failed:', err.message);
        res.status(500).json({ successful: false, message: 'Could not update incident' });
    }
});

export default router;
