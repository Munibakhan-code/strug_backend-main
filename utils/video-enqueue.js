import prisma from './prisma-client.js';
import { pushToVideoQueue } from './azure-queue.js';

/**
 * Enqueue a Videos-vertical transcode task AND record that we did.
 *
 * Use this instead of pushToVideoQueue() for anything in the `video` table. The stamp is what lets
 * the reconciliation sweep tell an enqueue that was LOST apart from one that is merely waiting its
 * turn — see enqueueLikelyLost() in workers/video-reconciliation.js.
 *
 * ⚠️ Why the stamp is NOT inside pushToVideoQueue, which would be the obvious single choke point:
 * that function is shared with town hall posts (`type: 'townhall'`, keyed on post_id) and with ad
 * campaigns (routes/ads-moderation-routes.js, keyed on campaign_id and carrying NO type at all).
 * Stamping there would write a campaign_id or post_id onto whatever `video` row happens to share
 * that number — the exact cross-entity id collision that bug #415 was. Keep this video-only.
 *
 * The stamp is best-effort and deliberately AFTER the push: the message is what does the work, and a
 * failed stamp must never lose it. A missed stamp leaves last_enqueued_at stale, which makes the
 * sweep consider the video recoverable and re-queue it — a harmless duplicate the worker dedups,
 * and the safe direction to fail in. The opposite (claiming we enqueued when we did not) would
 * strand the video, which is the failure this whole change exists to fix.
 *
 * @param {number} videoId
 * @param {string} blobName
 * @param {object} metadata forwarded to pushToVideoQueue (e.g. { lane: 'bulk' })
 * @returns {Promise<boolean>} whatever pushToVideoQueue returned
 */
export async function enqueueVideoTask(videoId, blobName, metadata = {}) {
    const pushed = await pushToVideoQueue(videoId, blobName, metadata);
    try {
        await prisma.video.update({
            where: { video_id: Number(videoId) },
            data: { last_enqueued_at: new Date() },
            select: { video_id: true },
        });
    } catch (err) {
        console.warn(`[video-enqueue] could not stamp last_enqueued_at for video ${videoId}: ${err.message}`);
    }
    return pushed;
}
