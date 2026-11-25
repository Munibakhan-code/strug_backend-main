import prisma from '../utils/prisma-client.js';
import { isAzureStorageConfigured, uploadBlobFromUrl } from '../utils/azure-storage.js';

// VOD archive. When the media server records streams to disk and exposes MediaMTX's playback
// server (reverse-proxied at LIVE_VOD_PLAYBACK_BASE, e.g. https://live.strug.ca/vod), a finished
// stream can be replayed by time-range. archiveSessionVod() persists a `live_vod` row pointing at
// that playback URL so the recording shows up under "Past Broadcasts".
//
// When AZURE_LIVE_VOD_CONTAINER + AZURE_STORAGE_CONNECTION_STRING are set, the finished recording
// is also copied to Azure Blob Storage (ststrugproduploads) and the permanent blob URL is stored
// instead of the ephemeral MediaMTX playback link.
//
// Shared by BOTH the RTMP `notReady` hook (routes/live-session-routes.js) and the live-session
// sweep (workers/live-session-sweep.js) — a stream that ends via the sweep (HLS probe / time-based
// net) instead of the notReady hook must still get archived, otherwise the recording exists on
// disk but is never surfaced.
//
// NO-OP unless LIVE_VOD_PLAYBACK_BASE is set — inert until the media server has `record: yes` +
// `playback: yes` and the proxy route is live. Best-effort and idempotent: never throws to its
// caller and writes at most one VOD per session.
const LIVE_VOD_PLAYBACK_BASE = process.env.LIVE_VOD_PLAYBACK_BASE;
const AZURE_LIVE_VOD_CONTAINER = process.env.AZURE_LIVE_VOD_CONTAINER || 'live-vods';
const LIVE_VOD_UPLOAD_TO_AZURE = process.env.LIVE_VOD_UPLOAD_TO_AZURE !== 'false';
/** When true, never persist a MediaMTX-only URL (ephemeral) — skip VOD row if Azure upload fails. */
const LIVE_VOD_REQUIRE_AZURE = process.env.LIVE_VOD_REQUIRE_AZURE === 'true'
  || process.env.LIVE_VOD_REQUIRE_AZURE === '1';

async function persistVodToAzure(session, mediamtxUrl, duration) {
    if (!LIVE_VOD_UPLOAD_TO_AZURE || !isAzureStorageConfigured()) return mediamtxUrl;
    const blobName = `vod/${session.streamer_id}/${session.session_id}-${Date.now()}.mp4`;
    try {
        const blobUrl = await uploadBlobFromUrl(AZURE_LIVE_VOD_CONTAINER, blobName, mediamtxUrl);
        console.log(`[archiveSessionVod] uploaded to Azure: ${blobName}`);
        return blobUrl;
    } catch (err) {
        console.warn('[archiveSessionVod] Azure upload failed, keeping MediaMTX URL:', err?.message);
        return mediamtxUrl;
    }
}

export async function archiveSessionVod(session, endedAt) {
    try {
        if (!LIVE_VOD_PLAYBACK_BASE) return;            // recording/playback not configured yet
        if (!session?.started_at || !session.stream_key) return; // never actually went live
        const startedAt = new Date(session.started_at);
        const elapsedSec = Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000));
        if (elapsedSec < 5) return;                     // ignore false starts / momentary blips
        // One VOD per session — notReady can fire on a brief disconnect, /end may race it, and the
        // sweep may also reach the same session; this guard keeps it to a single row.
        // Only full broadcasts block re-archive — clips share the same session_id.
        const existing = await prisma.live_vod.findFirst({
            where: { session_id: session.session_id, is_clip: false },
        });
        if (existing) return;
        const base = LIVE_VOD_PLAYBACK_BASE.replace(/\/$/, '');
        const key = encodeURIComponent(session.stream_key);

        // Derive the replay window from the media server's ACTUAL recorded segments. Recording
        // begins a fraction of a second AFTER session.started_at, and MediaMTX /get only returns a
        // recording when `start` lands INSIDE a segment — so using started_at verbatim 404s
        // ("no recording segments found"). Query /list for the real segment start/duration.
        // Fallback if /list is unavailable: nudge started_at +2s so it lands inside the recording.
        let start = new Date(startedAt.getTime() + 2000).toISOString();
        let duration = Math.max(1, elapsedSec - 2);
        try {
            const r = await fetch(`${base}/list?path=${key}`, { signal: AbortSignal.timeout(5000) });
            if (r.ok) {
                const segs = await r.json();
                if (Array.isArray(segs) && segs.length) {
                    // SUM each segment's own duration rather than spanning first.start → last.end.
                    // A stream that dropped and reconnected leaves gaps between segments; spanning
                    // first→last counts those gaps, so /get would be asked for a window longer than
                    // the actual recorded content and truncate / 404 at the gap. With no gaps the
                    // sum equals the span, so this never shortens a contiguous recording.
                    const summedSec = segs.reduce((acc, s2) => acc + (Number(s2.duration) || 0), 0);
                    start = segs[0].start;
                    duration = Math.max(1, Math.ceil(summedSec));
                }
            }
        } catch (err) {
            console.warn('[archiveSessionVod] playback /list failed, using buffered session times:', err?.message);
        }

        // MediaMTX playback: GET /get?path=<key>&start=<RFC3339>&duration=<sec>&format=mp4
        const mediamtxUrl = `${base}/get?path=${key}&start=${encodeURIComponent(start)}&duration=${duration}&format=mp4`;
        if (LIVE_VOD_REQUIRE_AZURE && !isAzureStorageConfigured()) {
            console.error('[archiveSessionVod] LIVE_VOD_REQUIRE_AZURE set but Azure storage is not configured — skipping VOD row');
            return;
        }
        const video_url = await persistVodToAzure(session, mediamtxUrl, duration);
        if (LIVE_VOD_REQUIRE_AZURE && video_url === mediamtxUrl) {
            console.error('[archiveSessionVod] Azure upload required but failed — not persisting ephemeral MediaMTX URL');
            return;
        }
        await prisma.live_vod.create({
            data: {
                session_id: session.session_id,
                streamer_id: session.streamer_id,
                video_url,
                title: session.title || `Stream — ${startedAt.toLocaleDateString()}`,
                description: session.description || null,
                thumbnail_url: session.thumbnail_url || null,
                duration_sec: duration,
                visibility: 'PUBLIC',
            },
        });
    } catch (err) {
        console.error('[archiveSessionVod] failed:', err?.message);
    }
}

/**
 * Create a clip from a parent VOD by exporting a MediaMTX time-range slice.
 * Throws errors with `.code` for the route layer to map to HTTP statuses.
 */
export async function createClipFromVod({
    parentVod,
    session,
    startSec,
    durationSec,
    title,
    clippedByUserId,
}) {
    if (!LIVE_VOD_PLAYBACK_BASE) {
        const e = new Error('Clip export is not configured (LIVE_VOD_PLAYBACK_BASE).');
        e.code = 'CLIP_UNAVAILABLE';
        throw e;
    }
    if (!session?.stream_key || !session?.started_at) {
        const e = new Error('Parent stream has no archive window.');
        e.code = 'CLIP_NO_ARCHIVE';
        throw e;
    }

    const parentDuration = Math.max(0, Number(parentVod.duration_sec) || 0);
    const start = Math.max(0, Math.floor(Number(startSec) || 0));
    let duration = Math.min(60, Math.max(5, Math.floor(Number(durationSec) || 30)));
    if (parentDuration > 0 && start >= parentDuration) {
        const e = new Error('Clip start is past the end of the broadcast.');
        e.code = 'CLIP_OUT_OF_RANGE';
        throw e;
    }
    if (parentDuration > 0) {
        duration = Math.min(duration, Math.max(1, parentDuration - start));
    }

    const base = LIVE_VOD_PLAYBACK_BASE.replace(/\/$/, '');
    const key = encodeURIComponent(session.stream_key);
    const startedAt = new Date(session.started_at);

    // Align clip window to MediaMTX recording segments when available.
    let absStart = new Date(startedAt.getTime() + start * 1000 + 2000);
    try {
        const r = await fetch(`${base}/list?path=${key}`, { signal: AbortSignal.timeout(5000) });
        if (r.ok) {
            const segs = await r.json();
            if (Array.isArray(segs) && segs.length && segs[0].start) {
                const seg0 = new Date(segs[0].start);
                absStart = new Date(seg0.getTime() + start * 1000);
            }
        }
    } catch (err) {
        console.warn('[createClipFromVod] playback /list failed, using session times:', err?.message);
    }

    const mediamtxUrl = `${base}/get?path=${key}&start=${encodeURIComponent(absStart.toISOString())}&duration=${duration}&format=mp4`;

    let video_url;
    try {
        // Prefer Azure permanent URL; fall back to MediaMTX range URL if Azure is off.
        if (LIVE_VOD_UPLOAD_TO_AZURE && isAzureStorageConfigured()) {
            const blobName = `clip/${session.streamer_id}/${session.session_id}-${Date.now()}.mp4`;
            video_url = await uploadBlobFromUrl(AZURE_LIVE_VOD_CONTAINER, blobName, mediamtxUrl);
        } else {
            // Verify the slice is reachable before inserting a row.
            const probe = await fetch(mediamtxUrl, {
                method: 'GET',
                headers: { Range: 'bytes=0-0' },
                signal: AbortSignal.timeout(10000),
            });
            if (!probe.ok && probe.status !== 206) {
                const e = new Error('Clip export failed — recording slice unavailable.');
                e.code = 'CLIP_EXPORT_FAILED';
                throw e;
            }
            video_url = mediamtxUrl;
        }
    } catch (err) {
        if (err.code === 'CLIP_EXPORT_FAILED') throw err;
        console.error('[createClipFromVod] export/upload failed:', err?.message);
        const e = new Error('Clip export failed — recording slice unavailable.');
        e.code = 'CLIP_EXPORT_FAILED';
        throw e;
    }

    const clipTitle = (title && String(title).trim().slice(0, 255))
        || `Clip: ${parentVod.title || 'Broadcast'}`.slice(0, 255);

    return prisma.live_vod.create({
        data: {
            session_id: parentVod.session_id,
            streamer_id: parentVod.streamer_id,
            video_url,
            thumbnail_url: parentVod.thumbnail_url || null,
            title: clipTitle,
            duration_sec: duration,
            visibility: 'PUBLIC',
            is_clip: true,
            clipped_by_user_id: clippedByUserId || null,
        },
        include: {
            streamer: {
                select: {
                    user_id: true,
                    handle: true,
                    display_name: true,
                    profile_pic_url: true,
                    category: { select: { category_name: true } },
                },
            },
            clipped_by: { select: { user_id: true, username: true, name: true } },
        },
    });
}
