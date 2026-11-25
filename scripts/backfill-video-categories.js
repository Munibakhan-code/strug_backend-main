// One-off backfill: assign a content-based category to existing videos that are uncategorised
// (category NULL or the legacy default "General"). Uses the same LAYERED classifier as the live
// auto-categorisation cron (ai/classify-video-category.js): a no-LLM keyword heuristic, plus a
// multimodal Gemini pass on ambiguous cases when GOOGLE_API_KEY is set — so backfilled and
// freshly-uploaded videos are labelled identically.
//
// Safe to re-run: it only touches videos that are still uncategorised, and processes in small
// concurrent batches with per-video timeouts.
//
// Usage:
//   node scripts/backfill-video-categories.js [--dry-run] [--limit=N] [--concurrency=N]
//
// Requires DATABASE_URL. GOOGLE_API_KEY is OPTIONAL: without it the script runs heuristic-only
// (ambiguous videos stay "General"); with it, ambiguous videos also get the Gemini pass.

import 'dotenv/config';
import prisma from '../utils/prisma-client.js';
import { classifyVideoCategory } from '../ai/classify-video-category.js';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT = Number((args.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || 0;
const CONCURRENCY = Number((args.find(a => a.startsWith('--concurrency=')) || '').split('=')[1]) || 4;
const CLASSIFY_TIMEOUT_MS = 30 * 1000;

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function run() {
    console.log(process.env.GOOGLE_API_KEY
        ? 'Mode: heuristic + Gemini (ambiguous videos get an LLM pass).'
        : 'Mode: heuristic only (GOOGLE_API_KEY not set — ambiguous videos stay "General").');

    const where = {
        OR: [{ category: null }, { category: 'General' }],
        hls_url: { not: null },        // need a real thumbnail frame
        status: { not: 'banned' },
    };

    const total = await prisma.video.count({ where });
    console.log(`Found ${total} uncategorised video(s)${DRY_RUN ? ' (DRY RUN — no writes)' : ''}.`);
    if (total === 0) return;

    const videos = await prisma.video.findMany({
        where,
        select: { video_id: true, title: true, description: true, thumbnail_url: true },
        orderBy: { created_at: 'desc' },
        ...(LIMIT ? { take: LIMIT } : {}),
    });

    const counts = {};
    let processed = 0, set = 0, errored = 0;

    // Simple bounded-concurrency worker pool.
    let cursor = 0;
    async function worker() {
        while (cursor < videos.length) {
            const v = videos[cursor++];
            try {
                const { ok, category } = await withTimeout(
                    classifyVideoCategory({ title: v.title, description: v.description, thumbnailUrl: v.thumbnail_url }),
                    CLASSIFY_TIMEOUT_MS,
                    `classify ${v.video_id}`,
                );
                processed++;
                if (!ok) { errored++; continue; }
                counts[category ?? 'General'] = (counts[category ?? 'General'] || 0) + 1;
                // Only WRITE a confident category. Leave the ambiguous long tail untouched (it
                // stays whatever it was — null/General) so it isn't falsely asserted as "General"
                // and so the Gemini layer can categorise it on a later run when it's enabled.
                if (category) {
                    set++;
                    if (!DRY_RUN) {
                        await prisma.video.update({ where: { video_id: v.video_id }, data: { category } });
                    }
                    console.log(`#${v.video_id} → ${category}  ${DRY_RUN ? '(dry)' : ''}  "${(v.title || '').slice(0, 60)}"`);
                }
            } catch (err) {
                errored++;
                console.error(`#${v.video_id} failed: ${err.message}`);
            }
        }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, videos.length) }, worker));

    console.log('\n--- Summary ---');
    console.log(`Processed: ${processed}  |  Categorised: ${set}  |  Errors (retry later): ${errored}`);
    console.log('Distribution:', JSON.stringify(counts, null, 2));
}

run()
    .catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
