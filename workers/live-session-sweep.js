import prisma from '../utils/prisma-client.js';
import { logCronError } from '../utils/cron-email.js';
import { finalizeLiveSession } from '../services/live-session-finalize.js';
import { LIVE_HLS_BASE } from '../services/live-playback.js';
// Single-flight across replicas: without this every replica fires the same tick.
import { scheduleInterval } from '../utils/cron-lock.js';

const VOD_ARCHIVE_SELECT = {
  session_id: true,
  stream_key: true,
  playback_id: true,
  started_at: true,
  streamer_id: true,
  title: true,
  status: true,
};

const HLS_INTERVAL_MS = 15 * 1000;
const HLS_GRACE_MS = 20 * 1000;
const HLS_MISS_LIMIT = 2;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const STARTING_STALE_MS = 15 * 60 * 1000;
const LIVE_MAX_MS = 24 * 60 * 60 * 1000;

let sweepIo = null;
const hlsMisses = new Map();

async function probeUrl(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(url, { method: 'GET', signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export async function reconcileLiveByHls() {
  if (!LIVE_HLS_BASE) return;
  let live;
  try {
    live = await prisma.live_session.findMany({
      where: { status: 'LIVE' },
      select: { session_id: true, playback_url: true, ...VOD_ARCHIVE_SELECT },
    });
  } catch (err) {
    console.warn('[live-sweep] hls reconcile query skipped:', err?.message);
    return;
  }

  const liveIds = new Set(live.map((s) => s.session_id));
  for (const id of hlsMisses.keys()) if (!liveIds.has(id)) hlsMisses.delete(id);

  const now = Date.now();
  for (const s of live) {
    const probeUrlStr = (s.stream_key && LIVE_HLS_BASE)
      ? `${LIVE_HLS_BASE.replace(/\/$/, '')}/${s.stream_key}/index.m3u8`
      : s.playback_url;
    if (!probeUrlStr || !String(probeUrlStr).startsWith(LIVE_HLS_BASE)) continue;
    if (s.started_at && now - new Date(s.started_at).getTime() < HLS_GRACE_MS) continue;

    const alive = await probeUrl(probeUrlStr);
    if (alive) {
      hlsMisses.delete(s.session_id);
      continue;
    }

    const misses = (hlsMisses.get(s.session_id) || 0) + 1;
    if (misses < HLS_MISS_LIMIT) {
      hlsMisses.set(s.session_id, misses);
      continue;
    }

    hlsMisses.delete(s.session_id);
    try {
      const endedAt = new Date();
      const result = await finalizeLiveSession({
        sessionId: s.session_id,
        session: s,
        status: 'FINISHED',
        endedAt,
        io: sweepIo,
      });
      if (result.updated) {
        console.log(`[live-sweep] ended LIVE session ${s.session_id} (HLS gone — broadcast stopped).`);
      }
    } catch (err) {
      console.warn('[live-sweep] failed to end session', s.session_id, err?.message);
    }
  }
}

export async function sweepStaleLiveSessions() {
  const now = Date.now();
  try {
    const cancelled = await prisma.live_session.updateMany({
      where: {
        status: { in: ['STARTING', 'IDLE'] },
        created_at: { lt: new Date(now - STARTING_STALE_MS) },
      },
      data: { status: 'CANCELLED', ended_at: new Date() },
    });
    if (cancelled.count > 0) {
      console.log(`[live-sweep] cancelled ${cancelled.count} stale STARTING/IDLE session(s).`);
    }

    const staleLive = await prisma.live_session.findMany({
      where: { status: 'LIVE', started_at: { lt: new Date(now - LIVE_MAX_MS) } },
      select: VOD_ARCHIVE_SELECT,
    });
    let endedCount = 0;
    for (const s of staleLive) {
      const endedAt = new Date();
      const result = await finalizeLiveSession({
        sessionId: s.session_id,
        session: s,
        status: 'FINISHED',
        endedAt,
        io: sweepIo,
      });
      if (result.updated) endedCount += 1;
    }
    if (endedCount > 0) {
      console.log(`[live-sweep] force-ended ${endedCount} orphaned LIVE session(s) past the 24h ceiling.`);
    }
  } catch (err) {
    logCronError('live-session-sweep', err);
  }
}

export function startLiveSessionSweep(io) {
  if (io) sweepIo = io;
  setTimeout(() => {
    reconcileLiveByHls().catch((err) => logCronError('live-session-sweep-hls', err));
  }, 20 * 1000);
  scheduleInterval('live-session-sweep-hls', () => {
    reconcileLiveByHls().catch((err) => logCronError('live-session-sweep-hls', err));
  }, HLS_INTERVAL_MS);
  setTimeout(() => {
    sweepStaleLiveSessions().catch((err) => logCronError('live-session-sweep', err));
  }, 30 * 1000);
  scheduleInterval('live-session-sweep-stale', () => {
    sweepStaleLiveSessions().catch((err) => logCronError('live-session-sweep', err));
  }, SWEEP_INTERVAL_MS);
}
