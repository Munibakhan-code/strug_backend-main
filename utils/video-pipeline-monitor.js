import prisma from './prisma-client.js';
import { getReconciliationHealth } from '../workers/video-reconciliation.js';
import { getSyntheticProbeHealth } from '../workers/video-synthetic-probe.js';
import { sendEmail, isResendConfigured } from '../services/email-service.js';
import { logCronError } from './cron-email.js';
import { stalledVideoWhere, GRACE_MS } from './video-stall.js';
import { getQueueDepths } from './azure-queue.js';

// ── Video pipeline health monitor ──────────────────────────────────────────────
//
// The transcode pipeline has a habit of failing SILENTLY: a dead worker, a wedged merge, or a
// reconciliation sweep that throws on every run (the null-filter regression) all look identical
// from outside — videos just quietly never get an hls_url and get served as raw MP4. Nobody is
// paged; we find out when a user complains, hours or days later (a 50-second clip sat for days).
//
// This monitor turns that silent degradation into a loud alert. Every few minutes it checks two
// independent signals and emails an ops address when either goes bad (and again when it recovers):
//
//   1. SWEEP HEARTBEAT — the reconciliation sweep stamps a timestamp every time its query runs
//      (workers/video-reconciliation.js). If that goes stale, the safety net beneath the pipeline
//      is itself down — exactly the failure that hid the last outage.
//   2. STUCK BACKLOG — count videos that uploaded but still have no hls_url well past the time any
//      transcode should take. A growing/old backlog means the worker or queue is wedged, no matter
//      what the container health says — UNLESS queue depth is also high, which means healthy
//      backlog under concurrent load (mass upload), not an outage.
//
// It only READS (Prisma + an in-process heartbeat) — it never touches the queue or mutates videos,
// so it cannot itself perturb the pipeline. Alerts route to VIDEO_ALERT_EMAIL; if that or Resend is
// unset it still logs to stderr, so detection never depends on email being wired.

const MONITOR_INTERVAL_MS = 5 * 60 * 1000;   // check every 5 minutes

// A successful sweep runs every 15m; 45m stale = ~3 missed runs = genuinely dead, not just slow.
const SWEEP_STALE_MS      = 45 * 60 * 1000;
// Right after boot the sweep hasn't run yet — don't cry about a heartbeat that was never set.
const BOOT_GRACE_MS       = 20 * 60 * 1000;
// A video is only "stuck" once it's older than this AND its last transcode attempt has gone quiet —
// see utils/video-stall.js for the full predicate. Re-exported here purely so the alert TEXT can
// state the same number the predicate actually uses; the filter itself is not duplicated.
const STUCK_MIN_AGE_MS    = GRACE_MS;
// Hard ceiling under concurrent load: raise past single-video baseline so queued work behind a
// busy worker does not page as "wedged" at 60m. Pair with queue-depth awareness below.
const OLDEST_STUCK_MAX_MS = 120 * 60 * 1000;
// Or alert on volume: this many videos past STUCK_MIN_AGE_MS means a backlog is building —
// suppressed when interactive queue depth shows they are simply waiting in line.
const STUCK_COUNT_ALERT   = 10;
// LIVENESS window. Backlog age alone cannot tell "wedged worker" from "healthy worker with a deep
// queue" — in both cases the waiting videos have a null/stale last_attempt_at, because a video the
// worker simply hasn't reached yet has never been attempted. So we also ask: did anything actually
// PUBLISH recently? See the note on signal 2 below.
const PROGRESS_WINDOW_MS  = 30 * 60 * 1000;
// …but liveness must not mute everything: if one video is still un-transcoded after THIS long while
// others keep publishing around it, it is not waiting its turn, it is not progressing. Still pages.
// 12h is deliberately generous: measured drain is ~12-19 videos/h, so during a large recovery a video
// can legitimately sit in the queue for hours. A tighter ceiling (6h) would re-create the very
// false-page this gate exists to remove. Nothing should lack HLS after 12h under any healthy load.
const STUCK_DESPITE_PROGRESS_MS = 12 * 60 * 60 * 1000;
// While unhealthy, don't spam — re-alert at most this often; always send the recovery notice.
const RE_ALERT_MS         = 60 * 60 * 1000;
// Synthetic probe is considered stale if its last SUCCESS is older than this (≈ a couple of missed
// probe cycles). Only used when the probe is enabled. Default probe interval is 60m.
const PROBE_STALE_MS      = 150 * 60 * 1000;
// Queue depth at/above this (or ≥ stuckCount) means "normal backlog under load", not wedged.
const QUEUE_BACKLOG_FLOOR = 5;

// Pure decision (exported for tests): given the two signals + thresholds, is the pipeline healthy
// and if not, why. No clock, no DB — every time-dependent value is passed in.
export function evaluatePipelineHealth({
    now,
    bootAt,
    lastSweepSuccessAt,
    stuckCount,
    oldestStuckMs,
    // Interactive + bulk approximate depths (null = unknown / storage not configured).
    interactiveQueueDepth = null,
    bulkQueueDepth = null,
    // Synthetic probe (optional third signal): only considered when the probe is enabled.
    probeEnabled = false,
    probeLastOk = null,        // boolean | null (null = hasn't run yet)
    probeLastAt = null,        // ms timestamp of the last probe result
    probeReason = null,        // failure detail when probeLastOk === false
    sweepStaleMs = SWEEP_STALE_MS,
    bootGraceMs = BOOT_GRACE_MS,
    oldestStuckMaxMs = OLDEST_STUCK_MAX_MS,
    stuckCountAlert = STUCK_COUNT_ALERT,
    probeStaleMs = PROBE_STALE_MS,
    queueBacklogFloor = QUEUE_BACKLOG_FLOOR,
    // Liveness: how many videos finished transcoding in the progress window.
    // null = unknown / read failed.
    recentCompletions = null,
}) {
    const reasons = [];
    const mins = (ms) => Math.round(ms / 60000);

    // 1. Sweep heartbeat.
    if (lastSweepSuccessAt == null) {
        const sinceBoot = now - bootAt;
        if (sinceBoot > Math.max(sweepStaleMs, bootGraceMs)) {
            reasons.push(`reconciliation sweep has not completed a single successful run since boot ${mins(sinceBoot)}m ago — the transcode safety net is down`);
        }
    } else if (now - lastSweepSuccessAt > sweepStaleMs) {
        reasons.push(`reconciliation sweep last succeeded ${mins(now - lastSweepSuccessAt)}m ago (stale > ${mins(sweepStaleMs)}m) — likely throwing on every run`);
    }

    // 2. Stuck backlog — gated on LIVENESS.
    //
    // "Old backlog" is not the same as "wedged". A video the worker simply hasn't reached yet has
    // never been attempted, so its last_attempt_at is null — indistinguishable, by backlog age
    // alone, from a video a dead worker abandoned. This claimed "worker/queue likely wedged" for
    // both. On 2026-07-21 that paged hourly for ~20h straight while the worker was healthy and
    // steadily draining a ~500-deep recovery queue — and because the mail looked identical to the
    // genuine outage earlier that day, the real incident was indistinguishable from the noise.
    //
    // So: ask whether anything actually PUBLISHED recently. Draining ⇒ not wedged, stay quiet.
    // Nothing publishing ⇒ wedged, page (and say so, with the evidence). One video outlasting
    // STUCK_DESPITE_PROGRESS_MS while others publish around it ⇒ that video is genuinely stuck, page.
    // recentCompletions == null means the caller didn't measure — keep the old paranoid behaviour.
    const draining = recentCompletions != null && recentCompletions > 0;
    // Check if we should suppress due to high queue depth (indicating normal backlog under load)
    const isNormalBacklog =
        (interactiveQueueDepth != null && interactiveQueueDepth >= QUEUE_BACKLOG_FLOOR) ||
        (interactiveQueueDepth != null && interactiveQueueDepth >= stuckCount);
    if (!isNormalBacklog) {
        let stuckReason = null;
        // Determine the appropriate threshold for the age-based check
        const ageThreshold = recentCompletions === null
            ? OLDEST_STUCK_MAX_MS / 2  // paranoid mode: use single-video baseline
            : oldestStuckMaxMs;         // normal mode: use the raised threshold for queue depth tolerance

        if (oldestStuckMs != null && oldestStuckMs > ageThreshold) {
            if (!draining) {
                const evidence = recentCompletions === 0
                    ? ` and nothing has published in ${mins(PROGRESS_WINDOW_MS)}m`
                    : '';
                stuckReason = `${stuckCount} video(s) uploaded but still un-transcoded; oldest stuck ${mins(oldestStuckMs)}m (> ${mins(ageThreshold)}m)${evidence} — worker/queue likely wedged`;
            } else if (oldestStuckMs > STUCK_DESPITE_PROGRESS_MS) {
                stuckReason = `${stuckCount} video(s) un-transcoded; oldest stuck ${mins(oldestStuckMs)}m despite ${recentCompletions} video(s) publishing in the last ${mins(PROGRESS_WINDOW_MS)}m — that video is not progressing`;
            }
        } else if (stuckCount >= stuckCountAlert && !draining) {
            // Alert based on high count of stuck videos, regardless of age.
            stuckReason = `${stuckCount} video(s) past the stuck count threshold of ${stuckCountAlert}`;
        }
        if (stuckReason) {
            reasons.push(stuckReason);
        }
    }

    // 3. Synthetic probe (only when enabled). Catches a fully-broken pipeline during a quiet
    // upload window, when signals 1–2 see nothing because nothing real flowed through.
    if (probeEnabled) {
        if (probeLastOk === false) {
            reasons.push(`synthetic video probe failed${probeReason ? `: ${probeReason}` : ''} — a test clip did not transcode end-to-end`);
        } else if (probeLastOk === true && probeLastAt != null && now - probeLastAt > probeStaleMs) {
            reasons.push(`synthetic video probe has not succeeded in ${mins(now - probeLastAt)}m (stale > ${mins(probeStaleMs)}m)`);
        }
        // probeLastOk === null (never run yet) → stay quiet; boot grace covers startup.
    }

    return { healthy: reasons.length === 0, reasons };
}

// Read the current stuck-video backlog (count + age of the oldest).
//
// This used to hand-roll its own filter that "mirrored" the sweep's. It didn't — it counted a video
// from 30m old regardless of last_attempt_at, while the sweep would not re-queue one whose attempt
// sat in a 30m–3h dead-zone. So the monitor paged, hourly, about videos the sweep was structurally
// unable to touch: an alert that said "broken" while nothing was even trying to fix it.
//
// Both now read the SAME predicate (utils/video-stall.js), so the alert is honest by construction:
// every video counted here is one the sweep is actively re-queueing. If it's still in this list an
// hour later, it is genuinely wedged and worth waking someone for.
async function readStuckBacklog(now) {
    const stuck = await prisma.video.findMany({
        where: stalledVideoWhere(now),
        select: { created_at: true },
        orderBy: { created_at: 'asc' },
        take: 500,
    });
    const stuckCount = stuck.length;
    const oldestStuckMs = stuckCount ? now - new Date(stuck[0].created_at).getTime() : null;
    return { stuckCount, oldestStuckMs };
}

// Liveness counterpart to readStuckBacklog: how many videos actually finished transcoding inside the
// progress window. This is what separates "deep queue, draining fine" from "worker is dead" — the
// backlog query alone cannot, since an unreached video and an abandoned one look the same.
// `updated_at` is @updatedAt on the video model, so it moves when the worker writes processing_status
// ='done'. Read-only, like the rest of this monitor.
async function readRecentCompletions(now, windowMs = PROGRESS_WINDOW_MS) {
    return prisma.video.count({
        where: {
            processing_status: 'done',
            updated_at: { gte: new Date(now - windowMs) },
        },
    });
}

async function sendAlert({ healthy, reasons, forMs }) {
    const mins = (ms) => Math.round(ms / 60000);
    const subject = healthy
        ? '✅ Strug video pipeline recovered'
        : '🚨 Strug video pipeline unhealthy';
    const lines = healthy
        ? [`The video transcode pipeline is healthy again after ~${mins(forMs)}m.`]
        : [
            `The video transcode pipeline looks unhealthy${forMs ? ` (ongoing ~${mins(forMs)}m)` : ''}:`,
            ...reasons.map((r) => `• ${r}`),
            '',
            'Likely actions: check the strug_worker container/queue and the reconciliation sweep logs.',
        ];

    // Always log — detection must not depend on email being configured.
    if (healthy) console.log(`[video-monitor] RECOVERED after ${mins(forMs)}m`);
    else console.error(`[video-monitor] UNHEALTHY:\n${reasons.map((r) => '  • ' + r).join('\n')}`);

    const to = process.env.VIDEO_ALERT_EMAIL?.trim();
    if (!to) { console.warn('[video-monitor] VIDEO_ALERT_EMAIL not set — alert logged only, no email sent'); return; }
    if (!isResendConfigured?.()) { console.warn('[video-monitor] Resend not configured — alert logged only'); return; }

    try {
        await sendEmail({
            to,
            subject,
            html: `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5">${lines.map((l) => l ? `<p style="margin:6px 0">${l.replace(/^• /, '&bull; ')}</p>` : '<br/>').join('')}</div>`,
            text: lines.join('\n'),
        });
        console.log(`[video-monitor] alert emailed → ${to}`);
    } catch (err) {
        console.error('[video-monitor] alert email failed:', err.message);
    }
}

// status_incident identity for the video pipeline. The status page derives "Video playback:
// Operational/Degraded" from whether an ongoing incident exists for this service_id.
const VIDEO_SERVICE_ID = 'video';
const VIDEO_SERVICE_NAME = 'Video playback';

// Mirror the current health into the status_incident table — the data source behind the public
// + internal /status page. DB-driven and idempotent (it reconciles against the ONE ongoing
// incident per service), so it self-heals across restarts and multiple replicas: a restart that
// loses in-process state still won't open a duplicate, and recovery still resolves the open row.
// Video degradation is 'degraded', not 'down' — playback continues via the raw-MP4 fallback, it's
// just un-transcoded/slow — so the public page says Degraded, not Outage.
async function syncStatusIncident(healthy, reasons) {
    try {
        const ongoing = await prisma.status_incident.findFirst({
            where: { service_id: VIDEO_SERVICE_ID, status: 'ongoing' },
            orderBy: { started_at: 'desc' },
        });
        const summary = reasons.join(' • ');
        if (!healthy) {
            if (!ongoing) {
                await prisma.status_incident.create({
                    data: {
                        service_id: VIDEO_SERVICE_ID,
                        service_name: VIDEO_SERVICE_NAME,
                        title: 'Video processing degraded',
                        severity: 'degraded',
                        status: 'ongoing',
                        summary,        // internal detail — admin view only
                        auto: true,
                    },
                });
            } else if (ongoing.summary !== summary) {
                await prisma.status_incident.update({ where: { id: ongoing.id }, data: { summary } });
            }
        } else if (ongoing) {
            await prisma.status_incident.update({
                where: { id: ongoing.id },
                data: { status: 'resolved', resolved_at: new Date() },
            });
        }
    } catch (err) {
        console.error('[video-monitor] status_incident sync failed:', err.message);
    }
}

let _running = false;
let _unhealthySince = null;
let _lastAlertAt = null;
const _bootAt = Date.now();

// One health check pass. `deps` is injectable so tests can drive it without a DB/clock/email.
export async function checkVideoPipelineHealth(deps = {}) {
    const now = deps.now ?? Date.now();
    const bootAt = deps.bootAt ?? _bootAt;
    const send = deps.send ?? sendAlert;
    const getHealth = deps.getReconciliationHealth ?? getReconciliationHealth;
    const readBacklog = deps.readStuckBacklog ?? readStuckBacklog;
    const readCompletions = deps.readRecentCompletions ?? readRecentCompletions;
    const syncIncident = deps.syncStatusIncident ?? syncStatusIncident;
    const getProbe = deps.getSyntheticProbeHealth ?? getSyntheticProbeHealth;
    const readDepths = deps.getQueueDepths ?? getQueueDepths;

    const { lastSweepSuccessAt } = getHealth();
    const { stuckCount, oldestStuckMs } = await readBacklog(now);
    // If the liveness read itself fails, fall back to null (= "unknown") so we degrade to the old
    // paranoid behaviour and page, rather than silently treating a DB error as "healthy".
    const recentCompletions = await readCompletions(now).catch((err) => {
        console.error('[video-monitor] recent-completions read failed:', err.message);
        return null;
    });
    const probe = getProbe(); // { enabled, last: { at, ok, reason } | null }
    let interactiveQueueDepth = null;
    let bulkQueueDepth = null;
    try {
        const depths = await readDepths();
        interactiveQueueDepth = depths?.interactive ?? null;
        bulkQueueDepth = depths?.bulk ?? null;
    } catch { /* storage optional — treat as unknown */ }

    const result = evaluatePipelineHealth({
        now, bootAt, lastSweepSuccessAt, stuckCount, oldestStuckMs,
        interactiveQueueDepth,
        bulkQueueDepth,
        probeEnabled: probe.enabled,
        probeLastOk: probe.last ? probe.last.ok : null,
        probeLastAt: probe.last ? probe.last.at : null,
        probeReason: probe.last ? probe.last.reason : null,
        recentCompletions,
    });

    // Status page source of truth — idempotent, every run, independent of the email transitions below.
    await syncIncident(result.healthy, result.reasons);

    if (!result.healthy) {
        if (_unhealthySince == null) _unhealthySince = now;
        const due = _lastAlertAt == null || (now - _lastAlertAt) > RE_ALERT_MS;
        if (due) { await send({ healthy: false, reasons: result.reasons, forMs: now - _unhealthySince }); _lastAlertAt = now; }
    } else if (_unhealthySince != null) {
        const forMs = now - _unhealthySince;
        _unhealthySince = null; _lastAlertAt = null;
        await send({ healthy: true, forMs });
    }

    return result;
}

// Test-only: clear the in-process alert-dedupe state so unit tests don't leak across cases.
export function __resetMonitorStateForTest() {
    _unhealthySince = null;
    _lastAlertAt = null;
}

export function startVideoPipelineMonitorCron() {
    if (_running) return;
    _running = true;
    console.log('[video-monitor] Starting video pipeline health monitor (every 5m)');
    setInterval(() => {
        checkVideoPipelineHealth().catch((err) => logCronError('video-pipeline-monitor', err));
    }, MONITOR_INTERVAL_MS);
}
