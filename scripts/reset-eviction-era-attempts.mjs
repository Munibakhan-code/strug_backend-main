// One-time repair: give back the transcode attempts that the 2026-07-22 eviction bug consumed.
//
// ─── What happened ────────────────────────────────────────────────────────────────────────────────
// The prod worker was evicted for exceeding its 8Gi ephemeral disk and SIGKILLed (exit 137) 5-13
// times an hour for about a day. An evicted container logs nothing, so each kill destroyed an
// in-flight transcode silently; the queue message reappeared at visibility timeout, the worker's
// beginAttempt() incremented processing_attempts, and the video moved one step closer to its
// lifetime cap having never actually failed at anything.
//
// The eviction bug is fixed (worker #148/#149 — zero evictions since). But the counters it inflated
// are monotonic and nothing resets them, so the backlog is full of videos carrying 3-5 attempts
// spent on an infrastructure fault that no longer exists.
//
// That is actively harmful, not merely untidy: the worker terminalizes at
// `attemptsSoFar >= LIFETIME_MAX_ATTEMPTS` and does so BEFORE transcoding, so a video sitting at 4
// attempts is marked "Unrecoverable: exhausted 5 transcode attempts" on its very next dequeue
// WITHOUT ONE REAL TRY. Ten videos died that way within 20 seconds at 11:38 on 2026-07-22, purely
// because the reconciliation sweep had just re-queued them.
//
// ─── Why this does not lose anything ──────────────────────────────────────────────────────────────
// Terminalizing only writes processing_status='error' + processing_error. The row is untouched and
// the raw source blob is untouched, which is why videos 895, 896 and 985 — all previously "error"
// with exhausted attempts — transcoded to a full ladder the moment their counters were reset.
// This script writes ONLY processing_attempts / processing_status / processing_error. It never
// deletes a row, a blob, or an hls_url.
//
// ─── Scope, and why it is this wide ───────────────────────────────────────────────────────────────
// Targets videos that are still un-transcoded (hls_url IS NULL), not banned, whose source upload
// actually completed, and that have burned at least one attempt.
//
// There is no field recording WHY an attempt was consumed, so "burned by an eviction" and
// "genuinely failing" are indistinguishable after the fact. Rather than invent a heuristic, this
// resets both — the cost is bounded and asymmetric:
//   • wrongly reset a genuinely poison video  → it burns its 5 attempts again and re-terminalizes,
//                                                costing some worker time. Self-correcting.
//   • wrongly leave an eviction victim        → it is marked failed forever without ever being
//                                                tried. Not self-correcting; needs a human.
// So resetting too widely is the safe direction.
//
// ⚠️ Deliberately does NOT enqueue anything. The reconciliation sweep owns enqueueing, and pushing
// from here too would double every message — the amplification this pipeline has already had twice.
// Reset the counters and let the sweep pick them up on its next pass.
//
// SAFE BY DEFAULT: dry-run (reports only). Pass --apply to write. --limit=N to cap.
//
//   node scripts/reset-eviction-era-attempts.mjs                  # report what WOULD change
//   node scripts/reset-eviction-era-attempts.mjs --apply
//   node scripts/reset-eviction-era-attempts.mjs --apply --limit=200

import prisma from '../utils/prisma-client.js';

const APPLY = process.argv.includes('--apply');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Math.max(1, parseInt(limitArg.split('=')[1], 10) || 0) : null;

// Same shape the sweep and monitor use for "this video still wants a rendition", minus the
// attempt/age gates — we WANT the ones that have burned attempts, including those already
// terminalized into 'error'.
const targetWhere = {
    hls_url: null,
    status: { not: 'banned' },
    raw_video_url: { not: 'pending_upload' },
    processing_attempts: { gt: 0 },
};

async function main() {
    console.log(`[reset-eviction-era-attempts] mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`);

    const rows = await prisma.video.findMany({
        where: targetWhere,
        select: {
            video_id: true,
            processing_status: true,
            processing_attempts: true,
            processing_error: true,
            created_at: true,
        },
        orderBy: { video_id: 'asc' },
        ...(LIMIT ? { take: LIMIT } : {}),
    });

    if (rows.length === 0) {
        console.log('Nothing to reset — no un-transcoded video is carrying a spent attempt.');
        return;
    }

    const byStatus = new Map();
    const byAttempts = new Map();
    let exhausted = 0;
    for (const r of rows) {
        byStatus.set(r.processing_status, (byStatus.get(r.processing_status) || 0) + 1);
        byAttempts.set(r.processing_attempts, (byAttempts.get(r.processing_attempts) || 0) + 1);
        if (/exhausted/i.test(r.processing_error || '')) exhausted++;
    }

    console.log(`\nCandidates: ${rows.length} un-transcoded video(s) carrying spent attempts.`);
    console.log('  by processing_status:');
    for (const [k, v] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`      ${String(k).padEnd(12)} ${v}`);
    }
    console.log('  by processing_attempts:');
    for (const [k, v] of [...byAttempts.entries()].sort((a, b) => a[0] - b[0])) {
        console.log(`      ${String(k).padEnd(12)} ${v}`);
    }
    console.log(`  already terminalized as "exhausted attempts": ${exhausted}`);

    if (!APPLY) {
        console.log('\nDRY-RUN — no writes. Re-run with --apply to reset these.');
        for (const r of rows.slice(0, 20)) {
            console.log(`   video ${r.video_id} status=${r.processing_status} attempts=${r.processing_attempts}`);
        }
        if (rows.length > 20) console.log(`   …and ${rows.length - 20} more`);
        return;
    }

    // Chunked so one oversized IN (...) can't blow the statement, and so a mid-run failure leaves a
    // partial-but-consistent result (every row either reset or untouched) rather than a torn one.
    const ids = rows.map((r) => r.video_id);
    const CHUNK = 200;
    let reset = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        const res = await prisma.video.updateMany({
            where: { video_id: { in: slice } },
            data: {
                processing_attempts: 0,
                processing_status: 'pending',
                processing_error: null,
            },
        });
        reset += res.count;
    }

    console.log(`\n✅ Reset ${reset} video(s) to processing_attempts=0, status='pending'.`);
    console.log('   No enqueue was performed — the reconciliation sweep will pick these up.');
}

main()
    .catch((err) => {
        console.error('[reset-eviction-era-attempts] FAILED:', err);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
