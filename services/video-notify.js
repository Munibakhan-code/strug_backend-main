// services/video-notify.js — tell a creator their upload finished, or failed.
//
// WHY THIS IS NOT JUST A notify() CALL AT THE TRANSCODE SITE:
//
// The transcode terminal states are written by `strug_worker`, a SEPARATE container. It has no
// Socket.IO server and its Prisma client is sliced to the `video` model, so it cannot write a
// `notification` row at all. Its only bridge back to the API is `redis.publish('system:events')`.
//
// And PROD HAS NO MANAGED REDIS (see index.js:540) — the bridge is inactive there and no
// VIDEO_READY event ever arrives. So notifying only on that bridge would ship a feature that
// works in staging and does nothing in production, which is the exact failure this is meant to
// fix: creators watching "processing" forever with no signal.
//
// Therefore terminal-state notification is driven from TWO places:
//   1. the Redis bridge (index.js)          — instant, where Redis exists
//   2. the reconciliation sweep (workers/)  — polls the DB, so it works in prod
//
// Both call notifyVideoTerminal(), which is IDEMPOTENT: it no-ops if this video already has a
// notification for this terminal state. That is what makes it safe to call from both.

import prisma from '../utils/prisma-client.js';
import { notify } from './notify.js';
// Single-flight across replicas: without this every replica fires the same tick.
import { scheduleInterval } from '../utils/cron-lock.js';

const COPY = {
  ready: {
    type: 'video.ready',
    title: 'Your video is ready',
    body: 'Processing finished — it is live now.',
  },
  failed: {
    type: 'video.failed',
    title: "Your video couldn't be processed",
    body: 'Something went wrong while transcoding. Try uploading it again.',
  },
};

/**
 * @param {import('socket.io').Server|undefined} io
 * @param {{video_id:number, title?:string|null, processing_status?:string|null, channel?:{user_id?:number}}} video
 * @param {'video'|'townhall'} [kind]
 * @returns {Promise<boolean>} true if a notification was created
 */
export async function notifyVideoTerminal(io, video, kind = 'video') {
  const userId = kind === 'townhall' ? video?.user_id : video?.channel?.user_id;
  const entityId = kind === 'townhall' ? video?.post_id : video?.video_id;
  if (!userId || !entityId) return false;

  const failed = String(video.processing_status || '') === 'error';
  const copy = failed ? COPY.failed : COPY.ready;
  const entityType = kind === 'townhall' ? 'town_hall_post' : 'video';

  try {
    // Idempotency. Both callers can legitimately see the same terminal video (the sweep runs every
    // 15m and the bridge fires instantly), and the sweep re-reads the same rows on every tick.
    // NOTE: this is a check-then-write, not a constraint — two callers racing inside the same
    // moment could both pass. The window is tiny and a duplicate bell row is harmless; a unique
    // index would need a migration and is not worth it for a best-effort notification.
    const vertical = kind === 'townhall' ? 'townhall' : 'video';
    const existing = await prisma.notification.findFirst({
      where: {
        user_id: userId,
        vertical,
        type: copy.type,
        entity_type: entityType,
        entity_id: entityId,
      },
      select: { notification_id: true },
    });
    if (existing) return false;

    await notify(io, {
      userId,
      vertical,
      type: copy.type,
      title: copy.title,
      body: video.title ? `“${video.title}” — ${copy.body}` : copy.body,
      urgency: 'ambient',
      entityType,
      entityId,
      actionUrl: kind === 'townhall' ? 'social' : 'videos',
      data: { video_id: entityId, kind },
    });
    return true;
  } catch (e) {
    // Fail-open: a notification problem must never break the transcode pipeline or the sweep.
    console.error('[video-notify]', e.message);
    return false;
  }
}

// ── prod-viable poller ──────────────────────────────────────────────────────────────────────
//
// The sweep in workers/video-reconciliation.js is gated on AZURE_STORAGE_CONNECTION_STRING and only
// ticks every 15 minutes — far too slow to tell someone their 86-second transcode finished. This is
// a plain DB poll instead: no Redis, no Azure, no worker cooperation. It is the path that actually
// runs in production.
//
// It only looks at rows that went terminal in the last LOOKBACK, so the scan stays bounded and a
// backlog of old videos doesn't get retro-notified the first time this ships.

const POLL_MS = 60_000;
const LOOKBACK_MS = 30 * 60 * 1000;
let _polling = false;

export async function pollTerminalVideos(io) {
  const since = new Date(Date.now() - LOOKBACK_MS);
  let created = 0;

  const videos = await prisma.video.findMany({
    where: {
      updated_at: { gte: since },
      processing_status: { in: ['done', 'error'] },
    },
    select: {
      video_id: true,
      title: true,
      processing_status: true,
      channel: { select: { user_id: true } },
    },
    take: 200,
  });
  for (const v of videos) {
    if (await notifyVideoTerminal(io, v, 'video')) created += 1;
  }

  const posts = await prisma.town_hall_post.findMany({
    where: {
      updated_at: { gte: since },
      processing_status: { in: ['done', 'error'] },
    },
    select: { post_id: true, user_id: true, processing_status: true },
    take: 200,
  });
  for (const p of posts) {
    if (await notifyVideoTerminal(io, { ...p, title: null }, 'townhall')) created += 1;
  }

  if (created > 0) console.log(`[video-notify] notified ${created} creator(s) of a terminal video state`);
  return created;
}

export function startVideoNotifyCron(io) {
  if (_polling) return;
  _polling = true;
  console.log('[video-notify] Starting terminal-video notification poll (every 60s)');
  scheduleInterval('video-notify-poll', () => {
    pollTerminalVideos(io).catch((e) => console.error('[video-notify] poll failed:', e.message));
  }, POLL_MS);
}

export default notifyVideoTerminal;
