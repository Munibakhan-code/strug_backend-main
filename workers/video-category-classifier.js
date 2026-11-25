import prisma from '../utils/prisma-client.js';
import { logCronError } from '../utils/cron-email.js';
import { classifyVideoCategory } from '../ai/classify-video-category.js';
// Single-flight across replicas: without this every replica fires the same tick.
import { scheduleInterval } from '../utils/cron-lock.js';

// Auto-categorisation sweep — fills in a content-based category for videos the creator left
// on "Auto" (stored as category=NULL). It runs AFTER transcode, when thumbnail_url points at
// a real frame of the video, so classification is grounded in the actual content (frame +
// title + description) rather than metadata alone.
//
// Design mirrors video-reconciliation.js (non-overlapping latch, per-op timeouts, bounded
// batch). It is intentionally decoupled from the transcode path: an upload becomes watchable
// the moment HLS is ready; its category fills in shortly after, on the next sweep. A video
// shows as "General" (the NULL display fallback) in the meantime — same as today.
//
// Classification is LAYERED (see ai/classify-video-category.js): a no-LLM keyword heuristic
// handles the clear-cut cases, and — only if GOOGLE_API_KEY is configured — Gemini breaks ties
// on ambiguous ones. So this sweep works with or without Gemini.
//
// Terminal states so a video is classified at most once:
//   • a category is returned → store it (done).
//   • ran but nothing fits → store explicit "General" so it isn't re-picked (done).
//   • a Gemini call was attempted and errored (transient) → leave NULL; the next sweep retries.

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;   // every 5 minutes
const BATCH = 20;                          // cap classifications per sweep (one LLM call each)
const DB_OP_TIMEOUT_MS = 60 * 1000;        // bound any single DB call (see reconciliation rationale)
const CLASSIFY_TIMEOUT_MS = 30 * 1000;     // bound the LLM+thumbnail-fetch per video

let _running = false;
let _sweeping = false;

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function classifyUncategorizedVideos() {
    if (_sweeping) return;
    _sweeping = true;
    try {
        const candidates = await withTimeout(prisma.video.findMany({
            where: {
                // null = creator left it on Auto (the upload route now normalises Auto→null). 'auto'
                // is the LEGACY sentinel some rows still carry from before that normalisation — match
                // it too so those get classified without a one-off backfill. Once classified a row
                // becomes a real category or 'General', so it exits this set (no re-churn).
                OR: [{ category: null }, { category: 'auto' }],
                hls_url: { not: null },         // transcode finished → thumbnail is a real frame
                status: { not: 'banned' },
            },
            select: { video_id: true, title: true, description: true, thumbnail_url: true },
            orderBy: { created_at: 'desc' },    // newest uploads get categorised first
            take: BATCH,
        }), DB_OP_TIMEOUT_MS, 'findMany uncategorized videos');

        if (candidates.length === 0) return;
        console.log(`[category-classifier] Classifying ${candidates.length} video(s).`);

        let set = 0;
        for (const v of candidates) {
            try {
                const { ok, category } = await withTimeout(
                    classifyVideoCategory({ title: v.title, description: v.description, thumbnailUrl: v.thumbnail_url }),
                    CLASSIFY_TIMEOUT_MS,
                    `classify video ${v.video_id}`,
                );
                if (!ok) continue; // transient model error — retry next sweep, leave NULL
                // category=null means "ran, nothing fit" → settle as explicit General so we stop re-picking it.
                await withTimeout(prisma.video.update({
                    where: { video_id: v.video_id },
                    data: { category: category ?? 'General' },
                }), DB_OP_TIMEOUT_MS, `update video ${v.video_id}`);
                if (category) set++;
            } catch (err) {
                console.error(`[category-classifier] Failed for video ${v.video_id}:`, err.message);
            }
        }
        console.log(`[category-classifier] Set a category on ${set}/${candidates.length} video(s).`);
    } catch (err) {
        console.error('[category-classifier] Sweep error:', err.message);
    } finally {
        _sweeping = false;
    }
}

export function startVideoCategoryClassifierCron() {
    if (_running) return;
    _running = true;
    // Runs with or without Gemini: the keyword heuristic needs no external service. With
    // GOOGLE_API_KEY set, ambiguous videos additionally get a multimodal LLM pass.
    const mode = process.env.GOOGLE_API_KEY ? 'heuristic + Gemini' : 'heuristic only';
    console.log(`[category-classifier] Starting auto-categorisation sweep (every 5m, ${mode})`);
    scheduleInterval('video-category-classifier', () => {
        classifyUncategorizedVideos().catch((err) => logCronError('video-category-classifier', err));
    }, SWEEP_INTERVAL_MS);
}
