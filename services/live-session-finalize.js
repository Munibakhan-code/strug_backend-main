import prisma from '../utils/prisma-client.js';
import { archiveSessionVod } from './live-vod-archive.js';

const TERMINAL = new Set(['FINISHED', 'CANCELLED', 'ENDED']);

/**
 * Single path for ending a live session: status → VOD archive → stream-ended socket.
 * Idempotent when the session is already terminal (still emits optionally via forceEmit).
 *
 * @param {object} opts
 * @param {number} opts.sessionId
 * @param {object} [opts.session] preloaded row (must include stream_key, started_at, streamer_id, title for archive)
 * @param {'FINISHED'|'CANCELLED'|'ENDED'} [opts.status='FINISHED']
 * @param {Date} [opts.endedAt]
 * @param {object} [opts.io] Socket.IO
 * @param {object} [opts.emitExtra] merged into stream-ended payload
 * @param {boolean} [opts.archive=true]
 * @returns {Promise<{ updated: boolean, session: object|null }>}
 */
export async function finalizeLiveSession({
  sessionId,
  session: preloaded = null,
  status = 'FINISHED',
  endedAt = new Date(),
  io = null,
  emitExtra = {},
  archive = true,
} = {}) {
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return { updated: false, session: null };
  }

  let session = preloaded;
  if (!session) {
    session = await prisma.live_session.findUnique({
      where: { session_id: sessionId },
      select: {
        session_id: true,
        stream_key: true,
        playback_id: true,
        started_at: true,
        streamer_id: true,
        title: true,
        status: true,
      },
    });
  }
  if (!session) return { updated: false, session: null };

  if (TERMINAL.has(session.status)) {
    return { updated: false, session };
  }

  const r = await prisma.live_session.updateMany({
    where: {
      session_id: sessionId,
      status: { notIn: ['FINISHED', 'CANCELLED', 'ENDED'] },
    },
    data: { status, ended_at: endedAt },
  });

  if (r.count === 0) {
    const latest = await prisma.live_session.findUnique({ where: { session_id: sessionId } });
    return { updated: false, session: latest };
  }

  if (archive && status === 'FINISHED') {
    try {
      await archiveSessionVod(session, endedAt);
    } catch (err) {
      console.error(`[live-finalize] archive failed for ${sessionId}:`, err?.message || err);
    }
  }

  try {
    io?.to(`stream_${sessionId}`).emit('stream-ended', {
      session_id: sessionId,
      ...emitExtra,
    });
  } catch { /* optional */ }

  const updated = await prisma.live_session.findUnique({ where: { session_id: sessionId } });
  return { updated: true, session: updated };
}

/**
 * End all active sessions for a streamer (e.g. channel deactivate).
 */
export async function finalizeActiveSessionsForStreamer(streamerId, { io = null, status = 'FINISHED' } = {}) {
  const active = await prisma.live_session.findMany({
    where: { streamer_id: streamerId, status: { in: ['STARTING', 'LIVE'] } },
    select: {
      session_id: true,
      stream_key: true,
      playback_id: true,
      started_at: true,
      streamer_id: true,
      title: true,
      status: true,
    },
  });
  const endedAt = new Date();
  const results = [];
  for (const s of active) {
    results.push(await finalizeLiveSession({
      sessionId: s.session_id,
      session: s,
      status,
      endedAt,
      io,
      archive: status === 'FINISHED',
    }));
  }
  return results;
}
