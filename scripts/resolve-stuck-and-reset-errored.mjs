// Two disjoint one-off repairs on the video backlog, in one auditable run.
//
// PHASE 1 — TERMINALIZE poison. A video un-transcoded for DAYS whose heartbeat is long stale is not
// "waiting its turn" — it is picked up, fails to make progress, and stalls, over and over, without
// ever exhausting its attempt budget (so nothing terminalizes it). It is the row every pipeline-
// health alert cites as "oldest stuck NNNNm". Video 798 has been stuck ~75h. Mark it 'error' so it
// drops out of the un-transcoded count and stops anchoring the alert. Reversible — a later reset can
// revive it if the real fix (more ephemeral disk) makes it transcodable.
//
// PHASE 2 — RESET the eviction-killed. Videos the 2026-07-23 ephemeral-disk crashloop drove to
// 'error' with "exhausted N transcode attempts" burned those attempts on an infra fault, not a real
// transcode failure (see reference: 895/896/985 transcoded fine after exactly this reset). Give them
// a clean slate so the sweep re-queues them.
//
// ─── Why they cannot collide ──────────────────────────────────────────────────────────────────────
// Phase 1 targets processing_status != 'error'; Phase 2 targets processing_status == 'error' AND the
// message contains 'exhausted'. Disjoint sets. Phase 1 runs FIRST and writes a 'stuck' message (not
// 'exhausted'), so the freshly-terminalized poison row can never be caught by Phase 2's reset.
//
// Writes ONLY processing_attempts / processing_status / processing_error. Never a row, blob, or
// hls_url. Does NOT enqueue — the reconciliation sweep owns that; pushing here too would double every
// message (the amplification this pipeline has already had twice).
//
// SAFE BY DEFAULT: dry-run (reports only). Pass --apply to write. --stuck-hours=N overrides 48.
//
//   node scripts/resolve-stuck-and-reset-errored.mjs
//   node scripts/resolve-stuck-and-reset-errored.mjs --apply

import prisma from '../utils/prisma-client.js';

const APPLY = process.argv.includes('--apply');
const hoursArg = process.argv.find((a) => a.startsWith('--stuck-hours='));
const STUCK_HOURS = hoursArg ? Math.max(1, parseInt(hoursArg.split('=')[1], 10) || 0) : 48;
const LIFETIME_MAX_ATTEMPTS = 5;   // mirror the worker
const HEARTBEAT_STALE_MS = 2 * 60 * 60 * 1000; // 2h since last pickup

async function main() {
    const now = Date.now();
    console.log(`[resolve-stuck-and-reset-errored] mode=${APPLY ? 'APPLY' : 'DRY-RUN'} stuck-threshold=${STUCK_HOURS}h`);

    // ── PHASE 1: poison to terminalize ────────────────────────────────────────────────────────────
    const poison = await prisma.video.findMany({
        where: {
            hls_url: null,
            status: { not: 'banned' },
            raw_video_url: { not: 'pending_upload' },
            processing_status: { not: 'error' },              // not already terminal
            processing_attempts: { lt: LIFETIME_MAX_ATTEMPTS }, // not attempt-exhausted (that's Phase 2)
            created_at: { lt: new Date(now - STUCK_HOURS * 3600 * 1000) },
            OR: [
                { last_attempt_at: null },
                { last_attempt_at: { lt: new Date(now - HEARTBEAT_STALE_MS) } },
            ],
        },
        select: { video_id: true, processing_status: true, processing_attempts: true, created_at: true, last_attempt_at: true },
        orderBy: { created_at: 'asc' },
    });

    console.log(`\nPHASE 1 — terminalize poison (stuck > ${STUCK_HOURS}h, heartbeat stale, attempts < ${LIFETIME_MAX_ATTEMPTS}): ${poison.length}`);
    for (const v of poison) {
        const ageH = Math.round((now - new Date(v.created_at).getTime()) / 3600000);
        const hbH = v.last_attempt_at ? Math.round((now - new Date(v.last_attempt_at).getTime()) / 3600000) : null;
        console.log(`   video ${v.video_id} status=${v.processing_status} attempts=${v.processing_attempts} age=${ageH}h heartbeat=${hbH == null ? 'never' : hbH + 'h'}`);
    }

    // ── PHASE 2: eviction-killed to reset ─────────────────────────────────────────────────────────
    const killed = await prisma.video.findMany({
        where: {
            hls_url: null,
            status: { not: 'banned' },
            raw_video_url: { not: 'pending_upload' },
            processing_status: 'error',
            processing_error: { contains: 'exhausted' },
        },
        select: { video_id: true, processing_attempts: true },
        orderBy: { video_id: 'asc' },
    });

    console.log(`\nPHASE 2 — reset eviction-killed (status=error, "exhausted"): ${killed.length}`);
    for (const v of killed) console.log(`   video ${v.video_id} attempts=${v.processing_attempts}`);

    if (!APPLY) {
        console.log('\nDRY-RUN — no writes. Re-run with --apply.');
        return;
    }

    // Phase 1 first (writes a 'stuck' message → cannot be re-caught by Phase 2's 'exhausted' filter).
    let terminalized = 0;
    for (const v of poison) {
        await prisma.video.update({
            where: { video_id: v.video_id },
            data: { processing_status: 'error', processing_error: `Unrecoverable: stuck >${STUCK_HOURS}h without progress (manual terminalize)` },
        });
        terminalized++;
    }

    const ids = killed.map((v) => v.video_id);
    let reset = 0;
    for (let i = 0; i < ids.length; i += 200) {
        const res = await prisma.video.updateMany({
            where: { video_id: { in: ids.slice(i, i + 200) } },
            data: { processing_attempts: 0, processing_status: 'pending', processing_error: null },
        });
        reset += res.count;
    }

    console.log(`\n✅ Terminalized ${terminalized} poison video(s); reset ${reset} eviction-killed video(s).`);
    console.log('   No enqueue performed — the reconciliation sweep will pick up the reset ones.');
}

main()
    .catch((err) => { console.error('[resolve-stuck-and-reset-errored] FAILED:', err); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
