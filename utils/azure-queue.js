// utils/azure-queue.js
import { QueueServiceClient } from "@azure/storage-queue";
import dotenv from 'dotenv';

dotenv.config();

// Two lanes, one worker.
//
// INTERACTIVE ("video-tasks") is for work a user is actively waiting on: a Videos-vertical upload
// sits on a progress bar and is unwatchable until it has an hls_url.
//
// BULK ("video-tasks-bulk") is for best-effort work whose content is already usable without it.
// A town hall post plays its raw media_url the moment it is created ΓÇö the HLS rendition is an
// optimization, not a prerequisite.
//
// They are separate queues because they shared one FIFO until 2026-07-14, and a ~230-post burst of
// town hall video head-of-line-blocked the Videos lane for hours: the worker takes 2 tasks at a
// time and some town hall clips take 6 minutes, so fresh uploads sat behind the burst and tripped
// the "15 videos past 30m without HLS" page. Nothing was broken or failing ΓÇö just queued behind
// work that nobody was waiting on. Priority has to live in the queue topology, because a single
// FIFO cannot express "these are not equally urgent" no matter how fast the worker drains it.
export const MAIN_QUEUE = 'video-tasks';
export const BULK_QUEUE = 'video-tasks-bulk';
// DEDICATED QUEUE CONSTANTS
export const SOCIAL_QUEUE = 'social-video-tasks';
export const TOWNHALL_QUEUE = 'townhall-video-tasks';
/** Lists a YouTube channel then copies each file onto Strug (bulk lane, not interactive). */
export const YOUTUBE_IMPORT_QUEUE = 'youtube-import-tasks';
/** Paste X profile → copy posts into Town Hall (separate from interactive video tasks). */
export const TOWNHALL_IMPORT_QUEUE = 'townhall-import-tasks';

const clients = new Map();

// Lazy Initialization: Fully circumvents any app.js module loading order races
function getQueueClient(name = MAIN_QUEUE) {
  if (clients.has(name)) return clients.get(name);

  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connectionString) {
    console.warn("[azure-queue] AZURE_STORAGE_CONNECTION_STRING is not set. Queue operations are bypassed.");
    return null;
  }

  try {
    const queueServiceClient = QueueServiceClient.fromConnectionString(connectionString);
    const client = queueServiceClient.getQueueClient(name);
    clients.set(name, client);
    return client;
  } catch (err) {
    console.error("[azure-queue] Failed to initialize QueueServiceClient:", err.message);
    return null;
  }
}

// === REPLACE pushToVideoQueue IN utils/azure-queue.js ===

/**
 * Pushes a video task payload to the Azure storage queue using safe Base64 encoding.
 * Supports additional metadata payload mappings for multi-vertical tasks.
 *
 * `lane` selects the queue and is NOT part of the message: which queue a task came from is
 * already implied by the queue it was read off, and putting it on the wire would let the two
 * disagree. Everything else in `metadata` is forwarded to the worker verbatim.
 *
 * @param {number} videoId
 * @param {string} blobName
 * @param {object} metadata Additional payload properties (e.g. { type: 'townhall' }), plus the
 *                          non-payload key `lane`: 'bulk' for best-effort work, default interactive.
 * @returns {Promise<boolean>}
 */
export async function pushToVideoQueue(videoId, blobName, metadata = {}) {
  const { lane, ...payloadMeta } = metadata;
  const queueName = lane === 'bulk' ? BULK_QUEUE : MAIN_QUEUE;
  const client = getQueueClient(queueName);
  if (!client) return false;

  try {
    await client.createIfNotExists();

    // Merge standard properties with vertical metadata safely
    const payload = JSON.stringify({ videoId, blobName, ...payloadMeta });
    const base64Payload = Buffer.from(payload, 'utf8').toString('base64');

    await client.sendMessage(base64Payload);
    return true;
  } catch (err) {
    console.error(`[azure-queue] Failed to push video ${videoId} to ${queueName}:`, err.message);
    throw err;
  }
}

/**
 * Deletes every message on the video-tasks queue.
 *
 * scripts/requeue-failed-transcodes.mjs imports this to drop a stale backlog
 * before re-enqueueing (--purge). The import is unconditional, so while this
 * export was missing the whole recovery script died at module load with
 * "does not provide an export named 'clearVideoQueue'" ΓÇö even without --purge.
 * That left stuck videos with no way back: the reconciliation sweep skips terminal
 * 'error' rows by design, and this script is the only thing that requeues them.
 *
 * @returns {Promise<boolean>} false when the queue is not configured.
 */
export async function clearVideoQueue() {
  const client = getQueueClient();
  if (!client) return false;

  try {
    await client.createIfNotExists();
    await client.clearMessages();
    return true;
  } catch (err) {
    console.error('[azure-queue] Failed to clear the video queue:', err.message);
    throw err;
  }
}

// The worker dead-letters a transcode it has given up on here (strug_worker index.js).
export const DEADLETTER_QUEUE = 'video-tasks-deadletter';

/**
 * Approximate depth of each lane, for the Engineering video-pipeline panel.
 *
 * Queue depth was the single most important number nobody could see during the 2026-07-14
 * incidents. Twice now the dashboard showed "N videos stuck" while the actual answer lived in the
 * queue: once a town hall burst had head-of-line-blocked the interactive lane (the reason the lanes
 * were split at all), and once a long video was failing to fan out while the queue sat flat.
 * "Stuck" and "backed up" and "wedged" look identical without these three numbers.
 *
 * `approximateMessagesCount` excludes messages that are currently INVISIBLE (leased by the worker,
 * or deferred by the dedup path), so a lane can read 0 while work is genuinely in flight ΓÇö pair it
 * with the in-flight rows, never read it alone.
 *
 * Returns null per lane when storage isn't configured, so the panel can say "unknown" rather than
 * render a confident zero.
 */
export async function getQueueDepths() {
  const lanes = { interactive: MAIN_QUEUE, bulk: BULK_QUEUE, deadletter: DEADLETTER_QUEUE };
  const out = {};

  await Promise.all(Object.entries(lanes).map(async ([lane, name]) => {
    const client = getQueueClient(name);
    if (!client) { out[lane] = null; return; }
    try {
      const props = await client.getProperties();
      out[lane] = props.approximateMessagesCount ?? 0;
    } catch (err) {
      // A lane that has never been written to may not exist yet ΓÇö that is 0, not an outage.
      if (err?.statusCode === 404) { out[lane] = 0; return; }
      console.error(`[azure-queue] Could not read depth of ${name}:`, err.message);
      out[lane] = null;
    }
  }));

  return out;
}

/**
 * Pushes a social video media attachment task to the dedicated social queue.
 */
export async function pushToSocialVideoQueue(attachmentId, postId, blobName, containerName) {
  const client = getQueueClient(SOCIAL_QUEUE);
  if (!client) return false;

  try {
    await client.createIfNotExists();
    const payload = JSON.stringify({
      type: 'social',
      videoId: attachmentId, // Passed as videoId to maintain contract with video-processor
      postId: postId,
      blobName: blobName,
      container: containerName || process.env.AZURE_SOCIAL_POSTS_CONTAINER || 'social-posts'
    });
    const base64Payload = Buffer.from(payload, 'utf8').toString('base64');
    await client.sendMessage(base64Payload);
    return true;
  } catch (err) {
    console.error(`[azure-queue] Failed to push task to ${SOCIAL_QUEUE}:`, err.message);
    throw err;
  }
}

/**
 * Enqueue a YouTube-library import (list the channel, then copy each file onto Strug).
 * Own queue so a 600-video scrape cannot sit in front of a creator waiting on one upload.
 */
export async function enqueueYoutubeImport(jobId, kind = 'list', extra = {}) {
  const client = getQueueClient(YOUTUBE_IMPORT_QUEUE);
  if (!client) return false;

  try {
    await client.createIfNotExists();
    const payload = JSON.stringify({
      type: 'youtube-import',
      kind,
      jobId,
      ...extra,
    });
    const base64Payload = Buffer.from(payload, 'utf8').toString('base64');
    await client.sendMessage(base64Payload);
    return true;
  } catch (err) {
    console.error(`[azure-queue] Failed to push YouTube import ${jobId} to ${YOUTUBE_IMPORT_QUEUE}:`, err.message);
    throw err;
  }
}

/**
 * Enqueue an X / Twitter → Town Hall library import (list profile, copy each post).
 */
export async function enqueueTownhallImport(jobId, kind = 'list', extra = {}) {
  const client = getQueueClient(TOWNHALL_IMPORT_QUEUE);
  if (!client) return false;

  try {
    await client.createIfNotExists();
    const payload = JSON.stringify({
      type: 'townhall-import',
      kind,
      jobId,
      ...extra,
    });
    const base64Payload = Buffer.from(payload, 'utf8').toString('base64');
    await client.sendMessage(base64Payload);
    return true;
  } catch (err) {
    console.error(`[azure-queue] Failed to push Town Hall import ${jobId} to ${TOWNHALL_IMPORT_QUEUE}:`, err.message);
    throw err;
  }
}
