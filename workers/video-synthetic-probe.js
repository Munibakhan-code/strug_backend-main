import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { BlobServiceClient } from '@azure/storage-blob';
import prisma from '../utils/prisma-client.js';
import { enqueueVideoTask } from '../utils/video-enqueue.js';
// Single-flight across replicas: without this every replica fires the same tick.
import { scheduleInterval } from '../utils/cron-lock.js';

// ── Synthetic video probe ──────────────────────────────────────────────────────
//
// The stuck-video monitor and any blob-scan only observe the pipeline when REAL videos flow
// through it. During a quiet upload window (which prod genuinely has) a fully-broken transcode
// pipeline looks identical to a healthy idle one — nothing is stuck because nothing was uploaded.
// This canary closes that blind spot: every interval it pushes a tiny bundled clip through the
// EXACT real path (raw blob → video row → video-tasks queue → worker → HLS) and checks that HLS
// comes back in time. The result feeds the monitor as a third health signal (alongside the sweep
// heartbeat and stuck backlog), so a failed probe raises the same "Video playback degraded"
// incident + alert. It cleans up after itself — every run deletes its test video, blobs and any
// leftovers from a prior run — so it never pollutes feeds or accumulates junk.
//
// OFF by default. Runs only when VIDEO_SYNTHETIC_PROBE_ENABLED=true AND VIDEO_PROBE_CHANNEL_ID
// points at a dedicated throwaway channel (the test video is created under it, status 'unlisted').

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIP_PATH = path.join(__dirname, '..', 'assets', 'synthetic-probe.mp4');
const MARKER = '[synthetic-probe]';

const INTERVAL_MS = Math.max(10, parseInt(process.env.VIDEO_PROBE_INTERVAL_MIN ?? '60', 10)) * 60 * 1000;
const TIMEOUT_MS = Math.max(2, parseInt(process.env.VIDEO_PROBE_TIMEOUT_MIN ?? '8', 10)) * 60 * 1000;
const POLL_MS = 10 * 1000;

let _running = false;
let _probing = false;
let _enabled = false;
let _channelId = null;
let _last = null; // { at:number, ok:boolean, durationSec?:number, reason?:string }

// Read by the pipeline monitor (utils/video-pipeline-monitor.js) as a third health signal.
export function getSyntheticProbeHealth() {
    return { enabled: _enabled, last: _last };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function blobNameFromUrl(rawUrl) {
    try { return decodeURIComponent(new URL(rawUrl).pathname.split('/').pop() || ''); }
    catch { return (rawUrl || '').split('/').pop() || ''; }
}

function containers(bsc) {
    return {
        raw: bsc.getContainerClient(process.env.AZURE_RAW_VIDEO_CONTAINER),
        processed: bsc.getContainerClient(process.env.AZURE_PROCESSED_VIDEO_CONTAINER),
        thumb: bsc.getContainerClient(process.env.AZURE_THUMBNAIL_CONTAINER),
    };
}

// Delete everything a probe video leaves behind: raw blob (the worker deletes it on success, this
// is the failure-path backstop), the processed HLS prefix, the thumbnail, and the DB row.
async function deleteProbeArtifacts(bsc, videoId, blobName) {
    const { raw, processed, thumb } = containers(bsc);
    if (blobName) { try { await raw.getBlobClient(blobName).deleteIfExists(); } catch { } }
    try {
        for await (const b of processed.listBlobsFlat({ prefix: `${videoId}/` })) {
            try { await processed.getBlockBlobClient(b.name).deleteIfExists(); } catch { }
        }
        for await (const b of processed.listBlobsFlat({ prefix: `temporary-chunks/${videoId}/` })) {
            try { await processed.getBlockBlobClient(b.name).deleteIfExists(); } catch { }
        }
    } catch { }
    try { await thumb.getBlobClient(`thumb-${videoId}.jpg`).deleteIfExists(); } catch { }
    // audit (backend low): delete non-cascading child rows in a transaction before the video,
    // so a probe row that happened to accrue any engagement can't FK-fail (P2003) the cleanup
    // and strand the probe. Mirrors DELETE /video/:id.
    try {
        await prisma.$transaction([
            prisma.video_analytics.deleteMany({ where: { video_id: videoId } }),
            prisma.video_comments.deleteMany({ where: { video_id: videoId } }),
            prisma.video_likes.deleteMany({ where: { video_id: videoId } }),
            prisma.video_watch_later.deleteMany({ where: { video_id: videoId } }),
            prisma.watch_history.deleteMany({ where: { video_id: videoId } }),
            prisma.playlist_item.deleteMany({ where: { video_id: videoId } }),
            prisma.video.delete({ where: { video_id: videoId } }),
        ]);
    }
    catch (e) { if (e?.code !== 'P2025') console.warn('[synthetic-probe] row delete failed:', e.message); }
}

// Remove probe videos stranded by a prior run (e.g. a crash mid-cycle) before starting a new one.
async function cleanupLeftovers(bsc) {
    const old = await prisma.video.findMany({
        where: { channel_id: _channelId, title: { startsWith: MARKER } },
        select: { video_id: true, raw_video_url: true },
    });
    for (const v of old) await deleteProbeArtifacts(bsc, v.video_id, blobNameFromUrl(v.raw_video_url));
    if (old.length) console.log(`[synthetic-probe] cleaned ${old.length} leftover probe video(s)`);
}

async function runProbeOnce() {
    if (_probing) return;
    _probing = true;
    const bsc = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
    let videoId = null;
    let blobName = null;
    const startedAt = Date.now();
    try {
        await cleanupLeftovers(bsc);

        const buf = await fs.promises.readFile(CLIP_PATH);
        const { raw } = containers(bsc);
        blobName = `synthetic-probe-${Date.now()}.mp4`;
        await raw.getBlockBlobClient(blobName).uploadData(buf, {
            blobHTTPHeaders: { blobContentType: 'video/mp4' },
        });

        const v = await prisma.video.create({
            data: {
                channel_id: _channelId,
                title: `${MARKER} ${new Date().toISOString()}`,
                raw_video_url: `${raw.url}/${blobName}`,
                status: 'pending_unlisted', // worker resolves to 'unlisted' — never public
                processing_status: 'pending',
            },
            select: { video_id: true },
        });
        videoId = v.video_id;

        await enqueueVideoTask(videoId, blobName);

        // Poll until the worker writes HLS (success) or marks it error, up to the timeout.
        const deadline = Date.now() + TIMEOUT_MS;
        let outcome = null;
        while (Date.now() < deadline) {
            await sleep(POLL_MS);
            const row = await prisma.video.findUnique({
                where: { video_id: videoId },
                select: { processing_status: true, hls_url: true, duration_sec: true },
            });
            if (row?.hls_url && row.processing_status === 'done') { outcome = { ok: true, durationSec: row.duration_sec }; break; }
            if (row?.processing_status === 'error') { outcome = { ok: false, reason: 'worker marked the probe video error' }; break; }
        }

        if (outcome?.ok) {
            _last = { at: Date.now(), ok: true, durationSec: outcome.durationSec, tookMs: Date.now() - startedAt };
            console.log(`[synthetic-probe] OK — transcoded in ${Math.round((Date.now() - startedAt) / 1000)}s`);
        } else {
            _last = { at: Date.now(), ok: false, reason: outcome?.reason || `no HLS within ${Math.round(TIMEOUT_MS / 60000)}m` };
            console.error(`[synthetic-probe] FAIL — ${_last.reason}`);
        }
    } catch (err) {
        _last = { at: Date.now(), ok: false, reason: err.message };
        console.error('[synthetic-probe] error:', err.message);
    } finally {
        if (videoId) await deleteProbeArtifacts(bsc, videoId, blobName).catch(() => { });
        _probing = false;
    }
}

export function startVideoSyntheticProbeCron() {
    if (_running) return;
    _enabled = process.env.VIDEO_SYNTHETIC_PROBE_ENABLED === 'true';
    _channelId = parseInt(process.env.VIDEO_PROBE_CHANNEL_ID ?? '', 10);

    if (!_enabled) { console.log('[synthetic-probe] disabled (set VIDEO_SYNTHETIC_PROBE_ENABLED=true to enable)'); return; }
    if (!Number.isInteger(_channelId) || _channelId <= 0) {
        console.warn('[synthetic-probe] enabled but VIDEO_PROBE_CHANNEL_ID is unset/invalid — not starting');
        _enabled = false; return;
    }
    if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
        console.warn('[synthetic-probe] AZURE_STORAGE_CONNECTION_STRING not set — not starting');
        _enabled = false; return;
    }
    if (!fs.existsSync(CLIP_PATH)) {
        console.warn(`[synthetic-probe] test clip missing at ${CLIP_PATH} — not starting`);
        _enabled = false; return;
    }

    _running = true;
    console.log(`[synthetic-probe] enabled — channel ${_channelId}, every ${Math.round(INTERVAL_MS / 60000)}m, timeout ${Math.round(TIMEOUT_MS / 60000)}m`);
    setTimeout(() => runProbeOnce().catch((e) => console.error('[synthetic-probe]', e.message)), 60 * 1000);
    scheduleInterval('video-synthetic-probe', () => runProbeOnce().catch((e) => console.error('[synthetic-probe]', e.message)), INTERVAL_MS);
}
