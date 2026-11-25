import { BlobServiceClient } from '@azure/storage-blob';
import prisma from '../utils/prisma-client.js';
import { pushToVideoQueue } from '../utils/azure-queue.js';
import { enqueueVideoTask } from '../utils/video-enqueue.js';
import { logCronError } from '../utils/cron-email.js';
import { stalledVideoWhere, stalledTownHallPostWhere, MAX_ATTEMPTS, GRACE_MS } from '../utils/video-stall.js';
// Single-flight across replicas: without this every replica fires the same tick.
import { scheduleInterval } from '../utils/cron-lock.js';

// Reconciliation sweep — the safety net beneath the transcode pipeline.
//
// A video becomes visible only once the standalone worker writes its hls_url. Normally a
// failed transcode is retried (and eventually dead-lettered) by the worker itself. But a
// transcode can also be LOST in ways the queue can't recover on its own:
//   • the enqueue at upload/finalize failed (finalize pushes fire-and-forget), so no message
//     was ever created;
//   • the worker was SIGKILLed (e.g. OOM) mid-transcode, before it could fail cleanly, and the
//     in-flight message later expired from the queue without redelivering.
// In both cases the video sits with processing_status pending/processing and a null hls_url
// forever — invisible, with no creator-facing signal. This sweep finds those and re-queues them.
//
// It does NOT consume the queue (that bug is exactly what orphaned videos before). It only
// re-enqueues, debounced by last_attempt_at and bounded by processing_attempts so a genuinely
// poison video can't churn forever (the worker dead-letters those into processing_status='error').

const SWEEP_INTERVAL_MS = 15 * 60 * 1000; // every 15 minutes
const BATCH = 50;                          // cap RE-QUEUES per sweep
const SCAN_MULTIPLIER = 4;                 // scan BATCH*4 candidates to find up to BATCH recoverable ones

// Duplicate-amplification guard.
//
// This sweep exists to recover enqueues that were LOST — a push that failed, a worker that died
// holding the only message. It does NOT exist to re-push work that is simply waiting its turn. But
// its trigger (`last_attempt_at` null or stale, see utils/video-stall.js) cannot tell those apart: a
// video sitting in a deep queue the worker hasn't REACHED yet looks exactly like one whose enqueue
// vanished. So with any real backlog the sweep re-pushes everything that has been waiting, every
// RETRY_AFTER_MS, forever.
//
// 2026-07-21: ~105 un-transcoded videos generated roughly 140 messages/hour that way. The queue went
// 151 -> 757 in twelve hours while only ~5 real videos/hour arrived. Correctness was never affected
// (the worker dedups, which is exactly why RETRY_AFTER_MS was lowered to 45m in the first place) —
// but it destroyed queue depth as a diagnostic, and queue depth is the number that was missing during
// BOTH 2026-07-14 incidents (see the note on getQueueDepths).
//
// ⚠️ The first attempt at this guard compared TOTAL lane depth against the outstanding count:
// "if the lane holds at least as many messages as there are outstanding videos, every candidate
// still has a message waiting, so skip". That premise only holds when the lane is full of
// duplicates OF THOSE SAME videos. It is false the moment the lane also carries unrelated work.
//
// 2026-07-22: a burst of new uploads filled the interactive lane, so the sweep logged
// "lane holds 254 message(s) for 132 outstanding video(s) — skipping" every 15 minutes for hours
// while the stalled backlog grew 74 -> 132 and NOT ONE old video was re-queued. A busy queue
// permanently starved recovery. Queue depth simply cannot say WHOSE messages it holds.
//
// ⚠️ The SECOND attempt asked it per video but still guessed with a clock: "was this video enqueued
// within RETRY_AFTER_MS (45m)?". That silently assumes a message is picked up inside 45 minutes.
// With a 570-deep lane draining at ~15/hour the real wait is ~38 HOURS, so every video aged out
// while still queued and was re-pushed every 45 minutes — the 2026-07-21 amplification again, just
// slower. The lane went 328 -> 570 -> 769 in ninety minutes.
//
// There is no safe fixed horizon here, because the right value IS queue latency, which varies by
// orders of magnitude. So stop guessing and compare the two stamps we already keep:
//
//   last_enqueued_at  — when WE last pushed a task           (enqueueVideoTask)
//   last_attempt_at   — when a WORKER last picked one up     (entity.beginAttempt)
//
//   last_attempt_at < last_enqueued_at  → our push has NOT been consumed yet
//                                          ⇒ the message is still in the lane, however deep ⇒ WAIT
//   last_attempt_at >= last_enqueued_at → a worker consumed it and the video is STILL stalled
//                                          ⇒ that attempt died ⇒ RECOVER
//
// This needs no horizon at all for the common case: a video queued behind 10,000 messages is never
// re-pushed, because nothing consumed its message. That is what stops the lane growing.
//
// ⚠️ MAX_QUEUED_WAIT_MS is only a BACKSTOP for the one case the comparison cannot see: a push that
// never produced a deliverable message (send silently dropped, message expired unread). Without it
// such a video waits forever. Deliberately generous — it must exceed real queue latency or it
// re-creates the amplification above.
//
// ⚠️ This only works because the sweep NO LONGER stamps last_attempt_at itself (it used to, as its
// own debounce). That write made every re-queued video look consumed the instant it was pushed,
// which both defeats this comparison and lies to the pipeline monitor's "grinding" count.
export const MAX_QUEUED_WAIT_MS = 24 * 60 * 60 * 1000;   // 24h — a backstop, NOT a retry cadence

const toMs = (v) => {
    if (v == null) return null;
    const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
    return Number.isFinite(t) ? t : null;
};

// Fails toward RECOVERY on purpose: an unknown/invalid stamp re-queues, producing at worst a
// duplicate that the worker dedups cheaply (it short-circuits on hls_url). The opposite failure —
// believing a message exists when it does not — strands the video forever, which is the bug above.
export function enqueueLikelyLost(lastEnqueuedAt, lastAttemptAt, now, maxQueuedWaitMs = MAX_QUEUED_WAIT_MS) {
    const enqueued = toMs(lastEnqueuedAt);
    if (enqueued == null) return true;        // never enqueued, predates the column, or corrupt
    if (enqueued > now) return true;          // future stamp can never "age out"

    const attempted = toMs(lastAttemptAt);
    if (attempted == null || attempted < enqueued) {
        // Nothing has consumed our push yet — it is queued. Only the backstop applies.
        return now - enqueued >= maxQueuedWaitMs;
    }
    return true;                              // consumed, yet still stalled ⇒ that attempt died
}

// An un-streamable video this old whose source can't be located (no derivable blob name) or that
// has burned through MAX_ATTEMPTS is UNRECOVERABLE — re-queuing can never make progress. Left as-is
// it keeps processing_status != 'error' with a null hls_url FOREVER, so the pipeline monitor pages
// every hour about a video nothing can fix (exactly the "1 video wedged, oldest stuck Nm" alerts
// that never clear — the video was silently skipped by the re-queue loop below, never terminalized).
// Reap it to 'error' instead: the creator dashboard shows "Failed" (accurate) and the stuck-backlog
// alert clears. Matches GRACE_MS so it's reaped as soon as it would first have been eligible anyway.
const TERMINAL_REAP_MS = GRACE_MS;         // 30 minutes

// A row still sitting at raw_video_url='pending_upload' this long after /presign created it has
// been abandoned: finalize fires the moment the blob PUT completes, so a genuine in-flight upload
// never lingers here for hours. Generous on purpose — big files on slow links, and uploadManager
// keeps uploading in the background across navigations — so we never kill a live upload.
const ABANDONED_UPLOAD_MS = 6 * 60 * 60 * 1000; // 6 hours

// Hard ceiling on any single DB call in the sweep. Prisma has NO default query timeout, and
// Postgres here runs with statement_timeout=0, so a dropped/half-open DB connection leaves the
// awaited query pending FOREVER — it never resolves and never rejects. That is exactly how the
// sweep wedged in prod (2026-06-21): the post-boot findMany hung on a reset connection, the
// _sweeping latch below stayed true, and every later run no-op'd → the heartbeat never stamped
// and the pipeline monitor (correctly) paged that the safety net was down. Bounding each call
// converts that silent hang into a thrown error → logged → latch released → retried next run.
const DB_OP_TIMEOUT_MS = 60 * 1000;        // 1 min (a 50-row findMany should take ms)
// Belt-and-suspenders: if a sweep ever holds the latch longer than this (e.g. a hang somewhere
// the timeout doesn't wrap), force-take it on the next tick so the sweep can never wedge forever.
const SWEEP_WATCHDOG_MS = 2 * SWEEP_INTERVAL_MS; // 30 minutes

let _running = false;
let _sweeping = false;
let _sweepStartedAt = null;

// Reject if `promise` hasn't settled within `ms`. The underlying op is left to settle on its own
// (a truly hung promise simply leaks, pending) — the point is that OUR await stops waiting, so the
// sweep's finally runs, the latch clears, and the next interval retries instead of hanging behind it.
export function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Heartbeat for the pipeline monitor. Set ONLY once the candidate query has executed
// successfully — that is the exact line the null-filter bug threw on, so a regression of that
// kind leaves this timestamp frozen and the monitor (video-pipeline-monitor.js) alerts. A
// failure in the per-video re-queue loop is logged separately and does NOT mark the sweep
// unhealthy (the query ran; that's what this attests). Null until the first successful sweep.
let _lastSuccessAt = null;

// NOTE: the key MUST be `lastSweepSuccessAt` — that is exactly what the monitor destructures
// (video-pipeline-monitor.js `const { lastSweepSuccessAt } = getHealth()`). This used to return
// `lastSuccessAt`, so the monitor read `undefined` on every run and — once boot grace lapsed —
// reported "sweep never completed a single successful run since boot" forever, paging a false
// outage 45m after every restart even though the sweep was healthy. The pure evaluator and the
// monitor's own tests both used the correct key, so the mismatch was invisible until prod.
export function getReconciliationHealth() {
    return { lastSweepSuccessAt: _lastSuccessAt };
}

// Derive the raw blob name the worker needs from the stored raw_video_url — i.e. everything
// AFTER the container segment. Uploads live under a `raw/` folder (videos-raw/raw/<file>), so
// `.split('/').pop()` (last segment only) dropped the folder → the worker's download and the
// reaper's exists() probe both looked at videos-raw/<file> and 404'd. A perfectly valid upload
// then failed every re-queue with "blob does not exist" until it burned MAX_ATTEMPTS and was
// wrongly terminalized 'error' (prod video 1698). Mirror routes/video-routes.js blobNameFromUrl:
// keep the full sub-path relative to the container.
export function blobNameFromUrl(rawUrl) {
    try {
        const segments = new URL(rawUrl).pathname.split('/').filter(Boolean); // [container, ...blobPath]
        return decodeURIComponent(segments.slice(1).join('/'));
    } catch {
        return (rawUrl || '').split('/').pop() || '';
    }
}

/** Same default as town-hall-routes create enqueue — never social-posts unless the URL says so. */
export function townHallQueueContainer(mediaUrl, env = process.env) {
    const townhall = env.AZURE_TOWNHALL_POSTS_CONTAINER || 'townhall-posts';
    const social = env.AZURE_SOCIAL_POSTS_CONTAINER || 'social-posts';
    const allowed = [...new Set([townhall, social, 'townhall-posts', 'social-posts'].filter(Boolean))];
    let pathname = '';
    try {
        pathname = new URL(String(mediaUrl || '')).pathname;
    } catch {
        pathname = String(mediaUrl || '');
    }
    for (const name of allowed) {
        if (pathname.includes(`/${name}/`)) return name;
    }
    return townhall;
}

// Lazy client for the raw-upload container the worker transcodes from (same env the worker uses).
let _rawContainerClient = null;
function getRawContainerClient() {
    if (_rawContainerClient) return _rawContainerClient;
    const cs = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (!cs) return null;
    _rawContainerClient = BlobServiceClient
        .fromConnectionString(cs)
        .getContainerClient(process.env.AZURE_RAW_VIDEO_CONTAINER || 'videos-raw');
    return _rawContainerClient;
}

// Does the raw source blob still exist? true = present, false = gone (orphaned by a storage purge /
// lost upload), null = couldn't tell (no storage config / transient error → treat as "don't decide
// on this signal"). A missing raw blob is the ACTUAL root of the recurring "1 video wedged" alerts:
// a storage cleanup deleted raw files for videos that were never transcoded (hls_url=null), so they
// can never transcode and had no terminal state. Detecting it here lets the reaper fail the whole
// orphan set in ONE sweep instead of draining them one-at-a-time through the worker (each failed
// download briefly flips 'processing' and re-pages the monitor).
async function rawBlobExists(blobName) {
    const container = getRawContainerClient();
    if (!container || !blobName) return null;
    try {
        return await withTimeout(
            container.getBlockBlobClient(blobName).exists(),
            DB_OP_TIMEOUT_MS,
            `blob exists ${blobName}`,
        );
    } catch {
        return null; // transient — don't terminalize on an inconclusive probe
    }
}

// Mark a video terminally failed so it leaves the un-transcoded backlog. Both the sweep's
// re-queue candidate query and the pipeline monitor exclude processing_status='error', so this is
// what actually stops the recurring alert for a video that can never transcode.
async function terminalizeVideo(videoId, reason) {
    try {
        await withTimeout(prisma.video.update({
            where: { video_id: videoId },
            data: {
                processing_status: 'error',
                processing_error: String(reason).slice(0, 500),
                last_attempt_at: new Date(),
            },
        }), DB_OP_TIMEOUT_MS, `terminalize video ${videoId}`);
        return true;
    } catch (err) {
        if (err?.code === 'P2025') return true; // row already gone — nothing to do
        console.error(`[reconciliation] Failed to terminalize video ${videoId}:`, err.message);
        return false;
    }
}

// Pure decision (exported for tests): is a stuck video beyond recovery, and if so why? The sweep
// can never make progress on a video whose source blob can't be located (re-queuing it just skips
// forever) or that has exhausted its attempt budget. Everything else is recoverable — left for the
// normal re-queue path. No clock, no DB — mirrors evaluatePipelineHealth's pure-decision style.
export function classifyUnrecoverable({ blobName, processingAttempts, maxAttempts = MAX_ATTEMPTS }) {
    if (!blobName) {
        return { recoverable: false, reason: 'Unrecoverable: could not derive a source blob from raw_video_url' };
    }
    if (processingAttempts >= maxAttempts) {
        return { recoverable: false, reason: `Unrecoverable: exhausted ${maxAttempts} transcode attempts` };
    }
    return { recoverable: true, reason: null };
}

// Terminal reaper — the piece that makes "1 video wedged" alerts self-heal instead of paging
// forever. Independent of the re-queue window (NO last_attempt_at gate): find every un-streamable
// video old enough that recovery has definitively failed and terminalize only the UNRECOVERABLE
// ones (per classifyUnrecoverable). Recoverable-but-slow videos (valid blob, attempts remaining)
// are LEFT for the normal re-queue path — e.g. while the worker is catching up after a restart —
// so a transient worker outage never mass-fails a queue of good uploads.
async function reapUnrecoverableStuckVideos(now) {
    const reapCutoff = new Date(now - TERMINAL_REAP_MS);
    const zombies = await withTimeout(prisma.video.findMany({
        where: {
            hls_url: null,
            status: { not: 'banned' },
            raw_video_url: { not: 'pending_upload' },
            processing_status: { not: 'error' },
            created_at: { lt: reapCutoff },
        },
        select: { video_id: true, raw_video_url: true, processing_attempts: true },
        orderBy: { created_at: 'asc' },
        take: BATCH,
    }), DB_OP_TIMEOUT_MS, 'findMany reap candidates');

    let reaped = 0;
    for (const v of zombies) {
        const blobName = blobNameFromUrl(v.raw_video_url);
        const { recoverable, reason } = classifyUnrecoverable({
            blobName,
            processingAttempts: v.processing_attempts,
        });
        if (!recoverable) {
            if (await terminalizeVideo(v.video_id, reason)) reaped++;
            continue;
        }
        // Looks recoverable by name/attempts — but a derivable name doesn't mean the source still
        // EXISTS. Verify it: an orphaned raw blob (purged/lost) is the real, silent recurring cause,
        // and left alone it drains one-at-a-time through the worker and flaps the monitor. Terminalize
        // it here in bulk. exists()===true/null → genuinely recoverable/unknown → leave for re-queue.
        const exists = await rawBlobExists(blobName);
        if (exists === false) {
            if (await terminalizeVideo(v.video_id, 'Unrecoverable: raw source blob no longer exists (purged/lost)')) reaped++;
        }
    }
    if (reaped) console.log(`[reconciliation] Reaped ${reaped} unrecoverable stuck video(s) → 'error'.`);
}

// Abandoned-upload reaper. /presign (and /bulk/presign) create the video row up-front with
// raw_video_url = 'pending_upload', then the browser PUTs the file straight to blob storage and
// calls PATCH /:id/finalize to write the real URL. If that middle step never lands — user closes
// the tab, network dies, SAS expires — the row is stranded at 'pending' with a null hls_url and
// NO raw asset.
//
// Every other recovery path deliberately excludes raw_video_url = 'pending_upload': the re-queue
// branches and reapUnrecoverableStuckVideos above, the pipeline monitor, and
// scripts/requeue-failed-transcodes. Correctly so — there is no blob to transcode. But the
// consequence was that nothing terminalized these rows either, so an abandoned upload sat in
// 'pending' FOREVER and the UI rendered it as "still processing" with no way out (board #404).
//
// Anything still 'pending_upload' this long after creation is definitively abandoned: finalize
// runs immediately after the blob PUT completes, so a live upload never sits here for hours.
// Terminalizing lets the UI show a real "upload failed" state and lets the user retry.
async function reapAbandonedUploads(now) {
    const cutoff = new Date(now - ABANDONED_UPLOAD_MS);
    const abandoned = await withTimeout(prisma.video.findMany({
        where: {
            raw_video_url: 'pending_upload',
            hls_url: null,
            processing_status: { not: 'error' },
            status: { not: 'banned' },
            created_at: { lt: cutoff },
        },
        select: { video_id: true },
        orderBy: { created_at: 'asc' },
        take: BATCH,
    }), DB_OP_TIMEOUT_MS, 'findMany abandoned uploads');

    if (!abandoned.length) return;

    // "pending_upload" does NOT prove the file never arrived — only that finalize never ran. The
    // blob PUT goes straight to storage from the browser, so a finalize that is lost (tab closed
    // on the last chunk, network blip, 5xx on the PATCH) leaves the file safely uploaded and the
    // row still saying 'pending_upload'. Prod bore this out: 92 raw blobs against 1 video row.
    // Terminalizing on the row alone would throw away a perfectly good upload, so probe storage
    // first and only fail the ones whose file genuinely isn't there.
    const found = await findRawBlobsByVideoId(abandoned.map((v) => v.video_id));

    let recovered = 0;
    let reaped = 0;
    for (const v of abandoned) {
        const blobName = found.get(v.video_id);
        if (blobName) {
            if (await recoverAbandonedUpload(v.video_id, blobName)) recovered++;
        } else if (await terminalizeVideo(v.video_id, 'Upload never completed — the raw file never reached storage (abandoned presign)')) {
            reaped++;
        }
    }
    if (recovered) console.log(`[reconciliation] Recovered ${recovered} upload(s) whose blob landed but finalize never ran → re-queued.`);
    if (reaped) console.log(`[reconciliation] Reaped ${reaped} abandoned upload(s) with no blob in storage → 'error'.`);
}

// Locate the raw blob for each of `videoIds`. /bulk/presign names the blob
// `raw/<userId>-<ts>-<videoId>.<ext>`, so the id is recoverable from the name — but it is the LAST
// component, which no prefix query can target. One flat listing per sweep is cheap (the raw
// container holds the un-transcoded backlog, not the whole catalogue) and only runs when there is
// at least one abandoned row to resolve. Returns Map<videoId, blobName>; empty when storage is
// unconfigured or the listing fails, which leaves every row for the normal terminalize path.
//
// NOTE the single POST /presign names blobs `raw/<userId>-<ts>.<ext>` with NO video id, but that
// path creates no DB row at all (the row appears at POST /upload, already carrying its blob URL) —
// so it produces no 'pending_upload' rows and nothing here needs to match it.
async function findRawBlobsByVideoId(videoIds) {
    const out = new Map();
    const container = getRawContainerClient();
    if (!container || !videoIds.length) return out;

    const wanted = new Set(videoIds);
    try {
        await withTimeout((async () => {
            for await (const blob of container.listBlobsFlat({ prefix: 'raw/' })) {
                const id = videoIdFromRawBlobName(blob.name);
                if (id === null || !wanted.has(id) || out.has(id)) continue;
                out.set(id, blob.name);
                if (out.size === wanted.size) break;
            }
        })(), DB_OP_TIMEOUT_MS, 'list raw blobs');
    } catch (err) {
        console.error('[reconciliation] Could not list raw blobs:', err.message);
        return new Map(); // inconclusive — decide nothing on this signal
    }
    return out;
}

// Pure parse (exported for tests): pull the video id out of a /bulk/presign blob name, which is
// `raw/<userId>-<ts>-<videoId>.<ext>`. Returns null when the name carries no id — notably the single
// /presign shape `raw/<userId>-<ts>.<ext>`, whose trailing number is a TIMESTAMP, not a video id.
// Those must never match: mapping one onto a real video would point a row at somebody else's file.
// Requiring three '-'-separated numeric parts is what tells the two shapes apart.
export function videoIdFromRawBlobName(blobName) {
    const m = String(blobName || '').match(/(?:^|\/)(\d+)-(\d+)-(\d+)\.[A-Za-z0-9]+$/);
    return m ? Number(m[3]) : null;
}

// The blob is there; the row just never learned its URL. Write it in and re-queue — this is the
// same state finalize would have left behind, so the normal pipeline takes it from here.
async function recoverAbandonedUpload(videoId, blobName) {
    const container = getRawContainerClient();
    if (!container) return false;
    const rawUrl = container.getBlockBlobClient(blobName).url;
    try {
        await withTimeout(prisma.video.update({
            where: { video_id: videoId },
            data: {
                raw_video_url: rawUrl,
                processing_status: 'pending',
                processing_attempts: 0,
                last_attempt_at: new Date(),
            },
        }), DB_OP_TIMEOUT_MS, `recover video ${videoId}`);
    } catch (err) {
        if (err?.code === 'P2025') return false; // row deleted mid-sweep
        console.error(`[reconciliation] Failed to recover video ${videoId}:`, err.message);
        return false;
    }

    // Enqueue AFTER the row is committed: a message for a row still reading 'pending_upload' would
    // be dropped by the worker. If the push fails the row is now a normal stuck video, which the
    // re-queue path above picks up on the next sweep — no permanent loss either way.
    try {
        await enqueueVideoTask(videoId, blobName);
    } catch (err) {
        console.error(`[reconciliation] Recovered video ${videoId} but could not enqueue:`, err.message);
    }
    return true;
}

// #415: the same safety net, for town hall posts.
//
// Town hall video now goes through this pipeline too, so a post whose transcode dies must not sit
// on "processing" forever — that is exactly the failure mode of #404. The sweep above is entirely
// prisma.video-scoped and would never see a town_hall_post row.
//
// Re-enqueue anything that is still without an hls_url after the stall window, and terminalize it
// once it has burned its attempt budget so it stops churning and the client stops waiting.
export async function reconcileStalledTownHallPosts(now = Date.now()) {

    // Burned its budget → terminal 'error'. The client falls back to media_url (the raw upload),
    // so the post still plays; it just never gets a rendition.
    const exhausted = await prisma.town_hall_post.findMany({
        where: {
            media_type: 'video',
            hls_url: null,
            processing_attempts: { gte: MAX_ATTEMPTS },
            processing_status: { notIn: ['done', 'error'] },
        },
        select: { post_id: true },
        take: 50,
    });
    for (const p of exhausted) {
        await prisma.town_hall_post.update({
            where: { post_id: p.post_id },
            data: {
                processing_status: 'error',
                processing_error: `Unrecoverable: exhausted ${MAX_ATTEMPTS} transcode attempts`,
            },
        }).catch(() => {});
    }
    if (exhausted.length) {
        console.log(`[reconciliation] Terminalized ${exhausted.length} unrecoverable town hall post(s).`);
    }

    // Same shared predicate as the videos above (utils/video-stall.js). It closes three holes this
    // query had: no backstop for a corrupt/future last_attempt_at (invisible to the sweep forever),
    // the obsolete 3h recovery floor, and — the loud one — no grace window, so a brand-new post
    // (last_attempt_at still NULL, because the create path doesn't stamp it) was re-enqueued by the
    // very next sweep on top of the enqueue that had just fired. Every town hall video was
    // double-queued as a matter of course.
    const candidates = await prisma.town_hall_post.findMany({
        where: stalledTownHallPostWhere(now),
        select: { post_id: true, media_url: true },
        orderBy: { created_at: 'asc' },
        take: 25,
    });
    if (!candidates.length) return 0;

    let requeued = 0;
    for (const p of candidates) {
        try {
            await pushToVideoQueue(p.post_id, blobNameFromUrl(p.media_url), {
                type: 'townhall',
                // Create uses townhall-posts; this used to send AZURE_SOCIAL_POSTS_CONTAINER (#1215).
                container: townHallQueueContainer(p.media_url),
                // Bulk lane, same as the create path: the post plays media_url regardless, so this
                // safety net must never push a Videos-vertical upload back in the queue. Feeding 25
                // of these per sweep into the interactive lane is what starved video on 2026-07-14.
                lane: 'bulk',
            });
            await prisma.town_hall_post.update({
                where: { post_id: p.post_id },
                data: { processing_status: 'pending', last_attempt_at: new Date() },
            }).catch(() => {});
            requeued += 1;
        } catch (err) {
            console.error(`[reconciliation] town hall post ${p.post_id} re-queue failed:`, err.message);
        }
    }
    console.log(`[reconciliation] Re-queued ${requeued} stalled town hall post(s).`);
    return requeued;
}

export async function reconcileStalledVideos() {
    // Never overlap sweeps — but never let a wedged run latch the sweep forever either. If a prior
    // run has held the latch past the watchdog window, its DB op is hung beyond recovery; force a
    // fresh run rather than no-op'ing every interval until the next restart.
    if (_sweeping) {
        if (_sweepStartedAt && Date.now() - _sweepStartedAt < SWEEP_WATCHDOG_MS) return;
        console.error(`[reconciliation] previous sweep wedged >${Math.round(SWEEP_WATCHDOG_MS / 60000)}m — forcing a new run`);
    }
    _sweeping = true;
    _sweepStartedAt = Date.now();
    try {
        const now = Date.now();

        // THE definition of a recoverably-stalled video lives in utils/video-stall.js, and the
        // pipeline monitor pages off the exact same predicate. Keeping them in one place is the
        // point: when the sweep and the monitor each had their own, they drifted, and we paged for
        // hours about videos this query was structurally unable to return (see that file).
        const candidates = await withTimeout(prisma.video.findMany({
            where: stalledVideoWhere(now),
            select: { video_id: true, raw_video_url: true, last_enqueued_at: true, last_attempt_at: true },
            orderBy: { created_at: 'asc' },
            // Over-fetch, then filter, then cap at BATCH (below). Taking exactly BATCH here would
            // head-of-line block: once the oldest 50 all have an outstanding message, every sweep
            // would filter all 50 out and never look at the 51st — which may genuinely need
            // recovery. Scanning wider costs one indexed read and keeps recovery reachable.
            take: BATCH * SCAN_MULTIPLIER,
        }), DB_OP_TIMEOUT_MS, 'findMany stalled videos');

        // The query executed — the sweep is alive. Stamp the heartbeat before any early return so
        // a clean (zero-candidate) run still counts as success for the monitor.
        _lastSuccessAt = Date.now();

        // Reap the unrecoverable BEFORE the zero-candidate early return — a permanently-skipped
        // video is typically NOT a re-queue candidate, so this must run every sweep regardless.
        // Isolated so a reaper failure can't abort the re-queue loop (heartbeat already stamped).
        try {
            await reapUnrecoverableStuckVideos(now);
            await reapAbandonedUploads(now);
        } catch (reapErr) {
            console.error('[reconciliation] Reaper error:', reapErr.message);
        }

        // #415: town hall posts ride the same pipeline now, so they need the same safety net.
        // Isolated: a failure here must not abort the video re-queue loop below.
        try {
            await reconcileStalledTownHallPosts(now);
        } catch (thErr) {
            console.error('[reconciliation] Town hall reconcile error:', thErr.message);
        }

        if (candidates.length === 0) return;

        // Don't amplify — decide PER VIDEO by comparing our push against the worker's pickup
        // (see enqueueLikelyLost). A video whose message has not been consumed is still queued,
        // however deep the lane; re-pushing it would only manufacture a duplicate.
        const eligible = candidates.filter((v) => enqueueLikelyLost(v.last_enqueued_at, v.last_attempt_at, now));
        const queued = candidates.length - eligible.length;
        if (eligible.length === 0) {
            console.log(`[reconciliation] Skipping re-queue: all ${candidates.length} candidate(s) still have an un-consumed message in the lane.`);
            return;
        }
        const recoverable = eligible.slice(0, BATCH);

        console.log(`[reconciliation] Scanned ${candidates.length} stalled video(s) — re-queueing ${recoverable.length} (${queued} still queued, ${eligible.length - recoverable.length} deferred to next sweep).`);

        let requeued = 0;
        for (const v of recoverable) {
            const blobName = blobNameFromUrl(v.raw_video_url);
            if (!blobName) {
                // Not a transient skip: an unlocatable source can never be re-queued, so previously
                // this video sat un-transcoded forever and paged the monitor. Terminalize it.
                console.warn(`[reconciliation] Video ${v.video_id} has no derivable blob name — terminalizing (unrecoverable source).`);
                await terminalizeVideo(v.video_id, 'Unrecoverable: could not derive a source blob from raw_video_url');
                continue;
            }
            try {
                // enqueueVideoTask (not the bare push) — it stamps last_enqueued_at, which is what
                // stops the NEXT sweep from re-pushing this same video while its message is queued.
                // enqueueVideoTask (not the bare push) — it stamps last_enqueued_at, which is this
                // sweep's ONLY debounce now.
                //
                // ⚠️ Do NOT stamp last_attempt_at here. It used to be the debounce, and that was
                // wrong twice over: it made a merely-QUEUED video indistinguishable from one a
                // worker had picked up, which (a) defeats enqueueLikelyLost's comparison and (b)
                // fed the pipeline monitor a fake heartbeat — "grinding" jumped 0 -> 25 on
                // 2026-07-22 purely from this write, with no worker doing anything.
                // last_attempt_at means "a worker picked this up" and only beginAttempt may set it.
                await withTimeout(enqueueVideoTask(v.video_id, blobName), DB_OP_TIMEOUT_MS, `enqueue video ${v.video_id}`);
                await withTimeout(prisma.video.update({
                    where: { video_id: v.video_id },
                    data: { processing_status: 'pending' },
                }), DB_OP_TIMEOUT_MS, `update video ${v.video_id}`);
                requeued++;
            } catch (err) {
                // Leave last_attempt_at untouched so the next sweep retries this one.
                console.error(`[reconciliation] Re-queue failed for video ${v.video_id}:`, err.message);
            }
        }
        console.log(`[reconciliation] Re-queued ${requeued}/${candidates.length} stalled video(s).`);
    } catch (err) {
        console.error('[reconciliation] Sweep error:', err.message);
    } finally {
        _sweeping = false;
        _sweepStartedAt = null;
    }
}

export function startVideoReconciliationCron() {
    if (_running) return;
    if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
        console.warn('[reconciliation] AZURE_STORAGE_CONNECTION_STRING not set — sweep disabled');
        return;
    }
    _running = true;
    console.log('[reconciliation] Starting stalled-video reconciliation sweep (every 15m)');
    scheduleInterval('video-reconciliation', () => {
        reconcileStalledVideos().catch((err) => logCronError('video-reconciliation', err));
    }, SWEEP_INTERVAL_MS);
}
