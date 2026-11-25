// One-off recovery: re-queue videos whose transcode terminally FAILED (processing_status
// 'error', hls_url null). The 15-minute reconciliation sweep (workers/video-reconciliation.js)
// deliberately SKIPS 'error' videos — it assumes they are genuinely poison content the worker
// gave up on after MAX_ATTEMPTS, and surfaces them to the owner rather than churning the queue.
//
// That assumption breaks when the *worker itself* was buggy: on 2026-06-17 a bad ffmpeg arg
// ('-vsync vscf') failed frame extraction on EVERY video ("Extraction exited 234"), so the
// whole catalog ended up 'error' through no fault of the content. Once the worker is fixed and
// deployed (strug_worker#48), this script clears the failure state and re-enqueues the backlog
// so it actually transcodes. It reuses pushToVideoQueue() — the same enqueue path the app and
// the reconciliation sweep use — so the message shape always matches the deployed worker.
//
// SAFE BY DEFAULT: dry-run unless --commit is passed. Prints the DB host it is about to touch.
//
// Usage:
//   node scripts/requeue-failed-transcodes.mjs                 # dry run: report only
//   node scripts/requeue-failed-transcodes.mjs --commit        # reset + re-enqueue the backlog
//   node scripts/requeue-failed-transcodes.mjs --commit --limit 50
//   node scripts/requeue-failed-transcodes.mjs --commit --ids 272,273,326
//
// Run with the target environment's DATABASE_URL + AZURE_STORAGE_CONNECTION_STRING loaded
// (e.g. prod: `env $(grep -v '^#' .env.production | xargs) node scripts/requeue-failed-transcodes.mjs --commit`).

import prisma from '../utils/prisma-client.js';
import { pushToVideoQueue, clearVideoQueue } from '../utils/azure-queue.js';

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const PURGE = args.includes('--purge');           // clear the queue first (drop the old 3× backlog)
const INCOMPLETE = args.includes('--incomplete');  // re-queue ALL not-yet-streamable, not just 'error'
const limitArg = args.find(a => a.startsWith('--limit'));
const LIMIT = limitArg ? Number(limitArg.split('=')[1] ?? args[args.indexOf(limitArg) + 1]) : undefined;
const idsArg = args.find(a => a.startsWith('--ids'));
const ONLY_IDS = idsArg
    ? (idsArg.split('=')[1] ?? args[args.indexOf(idsArg) + 1] ?? '')
        .split(',').map(s => Number(s.trim())).filter(Number.isInteger)
    : null;

function blobNameFromUrl(rawUrl) {
    try {
        return decodeURIComponent(new URL(rawUrl).pathname.split('/').pop() || '');
    } catch {
        return (rawUrl || '').split('/').pop() || '';
    }
}

function dbHost() {
    try { return new URL(process.env.DATABASE_URL).host; } catch { return '(unparseable DATABASE_URL)'; }
}

async function main() {
    console.log(`[requeue] DB host: ${dbHost()}  |  mode: ${COMMIT ? 'COMMIT' : 'DRY RUN'}`);
    if (COMMIT && !process.env.AZURE_STORAGE_CONNECTION_STRING) {
        console.error('[requeue] AZURE_STORAGE_CONNECTION_STRING not set — cannot enqueue. Aborting.');
        process.exit(1);
    }

    const where = {
        // --incomplete: re-queue everything not yet streamable (error OR processing/pending with
        // null hls). Default: only terminally-failed ('error'). Both require a real raw upload.
        ...(INCOMPLETE ? {} : { processing_status: 'error' }),
        hls_url: null,
        status: { not: 'banned' },
        raw_video_url: { notIn: ['pending_upload', ''] },
        ...(ONLY_IDS ? { video_id: { in: ONLY_IDS } } : {}),
    };

    const candidates = await prisma.video.findMany({
        where,
        select: { video_id: true, raw_video_url: true, processing_attempts: true, title: true },
        orderBy: { created_at: 'asc' },
        ...(LIMIT ? { take: LIMIT } : {}),
    });

    console.log(`[requeue] ${candidates.length} failed video(s) match.`);
    if (candidates.length === 0) return;

    if (!COMMIT) {
        for (const v of candidates.slice(0, 20)) {
            console.log(`  - #${v.video_id} attempts=${v.processing_attempts} blob=${blobNameFromUrl(v.raw_video_url) || '(none)'}  ${v.title ?? ''}`);
        }
        if (candidates.length > 20) console.log(`  … and ${candidates.length - 20} more`);
        console.log('[requeue] DRY RUN — pass --commit to reset failure state and re-enqueue.');
        return;
    }

    if (PURGE) {
        console.log('[requeue] --purge: clearing the video-tasks queue (drops the old 3× backlog)…');
        await clearVideoQueue();
        console.log('[requeue] queue cleared.');
    }

    let ok = 0, skipped = 0, failed = 0;
    for (const v of candidates) {
        const blobName = blobNameFromUrl(v.raw_video_url);
        if (!blobName) { console.warn(`[requeue] #${v.video_id}: no derivable blob name — skipping`); skipped++; continue; }
        try {
            // Clear the terminal-failure state and reset the attempt counter so a fixed worker
            // (and the reconciliation sweep) get a clean slate, then re-enqueue.
            await prisma.video.update({
                where: { video_id: v.video_id },
                data: {
                    processing_status: 'processing',
                    processing_error: null,
                    processing_attempts: 0,
                    last_attempt_at: new Date(),
                },
            });
            await pushToVideoQueue(v.video_id, blobName);
            ok++;
        } catch (err) {
            console.error(`[requeue] #${v.video_id}: ${err.message}`);
            failed++;
        }
    }
    console.log(`[requeue] done — re-enqueued ${ok}, skipped ${skipped}, failed ${failed}.`);
}

main()
    .catch(err => { console.error('[requeue] fatal:', err); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
