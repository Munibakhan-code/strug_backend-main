// Safe purge of RAW video source blobs (the videos-raw container) — the storage cleanup that,
// done unsafely, caused the recurring "video transcode pipeline unhealthy — 1 video wedged" alerts.
//
// ── THE INVARIANT (why this script exists) ────────────────────────────────────────────────────
// A video's raw upload is its ONLY transcode source. Once the video is transcoded (hls_url set),
// the raw blob is disposable. But if you delete the raw blob of a video that has NOT been
// transcoded yet (hls_url = null), that video is orphaned FOREVER: it can never transcode (source
// gone) and shows up in every reconciliation sweep / pipeline-health check as "uploaded but
// un-transcoded". A June-2026 manual purge did exactly this (deleted 55 raw blobs; 32 of the
// videos had hls_url = null) and generated hours of hourly pipeline alerts.
//
// This script enforces the invariant STRUCTURALLY: it only ever considers raw blobs whose video
// row has a non-null hls_url. It cannot select an un-transcoded video, so it cannot orphan one.
// (The pipeline also now self-heals a missing raw blob via the reconciliation reaper, but the
// right fix is to not create the orphan in the first place.)
//
// SAFE BY DEFAULT: dry-run unless --commit. Prints the DB + storage account it is about to touch.
//
// Usage:
//   node scripts/purge-raw-blobs-safe.mjs                        # dry run: list purgeable raw blobs
//   node scripts/purge-raw-blobs-safe.mjs --older-than-days 30   # only transcoded > 30d ago
//   node scripts/purge-raw-blobs-safe.mjs --commit               # actually delete (transcoded only)
//   node scripts/purge-raw-blobs-safe.mjs --commit --limit 100
//
// Run with the target environment's DATABASE_URL + AZURE_STORAGE_CONNECTION_STRING loaded, e.g.:
//   env $(grep -v '^#' .env.production | xargs) node scripts/purge-raw-blobs-safe.mjs

import { BlobServiceClient } from '@azure/storage-blob';
import prisma from '../utils/prisma-client.js';

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const numArg = (flag, def) => {
    const a = args.find(x => x.startsWith(flag));
    if (!a) return def;
    const v = a.includes('=') ? a.split('=')[1] : args[args.indexOf(a) + 1];
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
};
const OLDER_THAN_DAYS = numArg('--older-than-days', 0);
const LIMIT = numArg('--limit', 0) || undefined;

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
    const cs = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (!cs) { console.error('[purge] AZURE_STORAGE_CONNECTION_STRING not set — aborting.'); process.exit(1); }
    const containerName = process.env.AZURE_RAW_VIDEO_CONTAINER || 'videos-raw';
    const container = BlobServiceClient.fromConnectionString(cs).getContainerClient(containerName);
    console.log(`[purge] DB: ${dbHost()}  |  raw container: ${containerName}  |  mode: ${COMMIT ? 'COMMIT' : 'DRY RUN'}`);

    // THE GUARD: hls_url must be set. An un-transcoded video (hls_url = null) can never be selected,
    // so its raw source can never be deleted here. Do not weaken this.
    const olderCutoff = OLDER_THAN_DAYS > 0 ? new Date(Date.now() - OLDER_THAN_DAYS * 86400_000) : null;
    const candidates = await prisma.video.findMany({
        where: {
            hls_url: { not: null },                       // ← transcoded ONLY (the invariant)
            raw_video_url: { notIn: ['pending_upload', ''] },
            ...(olderCutoff ? { created_at: { lt: olderCutoff } } : {}),
        },
        select: { video_id: true, raw_video_url: true, created_at: true },
        orderBy: { created_at: 'asc' },
        ...(LIMIT ? { take: LIMIT } : {}),
    });

    // Extra belt-and-suspenders: refuse to touch a raw blob still referenced by any un-transcoded
    // video sharing the same blob name (shouldn't happen, but never orphan on a data quirk).
    const unstreamable = await prisma.video.findMany({
        where: { hls_url: null, raw_video_url: { notIn: ['pending_upload', ''] } },
        select: { raw_video_url: true },
    });
    const protectedBlobs = new Set(unstreamable.map(v => blobNameFromUrl(v.raw_video_url)).filter(Boolean));

    console.log(`[purge] ${candidates.length} transcoded video(s) eligible; ${protectedBlobs.size} raw blob(s) protected (still un-transcoded).`);
    if (candidates.length === 0) return;

    let deleted = 0, skipped = 0, missing = 0, failed = 0;
    for (const v of candidates) {
        const blobName = blobNameFromUrl(v.raw_video_url);
        if (!blobName || protectedBlobs.has(blobName)) { skipped++; continue; }
        if (!COMMIT) {
            if (deleted < 20) console.log(`  - would delete raw/${blobName} (video #${v.video_id})`);
            deleted++;
            continue;
        }
        try {
            const client = container.getBlockBlobClient(blobName);
            const res = await client.deleteIfExists();
            if (res.succeeded) deleted++; else missing++;
        } catch (err) {
            console.error(`[purge] #${v.video_id} raw/${blobName}: ${err.message}`);
            failed++;
        }
    }
    if (!COMMIT) {
        if (deleted > 20) console.log(`  … and ${deleted - 20} more`);
        console.log(`[purge] DRY RUN — ${deleted} raw blob(s) would be deleted (transcoded videos only). Pass --commit to delete.`);
    } else {
        console.log(`[purge] done — deleted ${deleted}, already-gone ${missing}, skipped ${skipped}, failed ${failed}.`);
    }
}

main()
    .catch(err => { console.error('[purge] fatal:', err); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
