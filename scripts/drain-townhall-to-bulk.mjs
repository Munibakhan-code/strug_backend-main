// One-off remediation for the 2026-07-14 page: "15 video(s) past 30m without HLS".
//
// Nothing was broken. The worker was healthy, the dead-letter queue was empty, and every queued
// message was fresh (dequeueCount 0). A ~230-post burst of town hall video had simply landed in
// `video-tasks` AHEAD of real uploads, and with the worker taking 2 tasks at a time — some town hall
// clips run 6 minutes — the Videos vertical sat behind hours of work nobody was waiting on.
//
// The durable fix is the lane split (utils/azure-queue.js + the worker's src/utils/queue-lanes.js):
// town hall now enqueues to `video-tasks-bulk`, which the worker only drains when no interactive
// task is waiting. But that only routes NEW work. The messages already sitting in `video-tasks` stay
// in front of the videos until someone moves them — which is what this script does.
//
// It MOVES town hall messages to the bulk lane and leaves everything else exactly where it is. No
// transcode work is lost: a moved message is still processed, just at lower priority, and the post
// plays its raw media_url in the meantime either way.
//
// SAFE BY DEFAULT: dry-run unless --commit is passed.
//
// Ordering note: deploy the lane-aware worker FIRST. An older worker does not read `video-tasks-bulk`,
// so anything moved there waits (harmlessly — the posts still play raw) until it rolls out.
//
// Usage:
//   node scripts/drain-townhall-to-bulk.mjs                  # dry run: report what would move
//   node scripts/drain-townhall-to-bulk.mjs --commit         # actually move them

import { QueueServiceClient } from '@azure/storage-queue';
import { MAIN_QUEUE, BULK_QUEUE } from '../utils/azure-queue.js';

const COMMIT = process.argv.includes('--commit');

// This script deletes from a live queue, so it should be rehearsable against throwaway queues before
// it is ever pointed at the real ones. These overrides exist for exactly that and nothing else — in
// prod, leave them unset and it operates on video-tasks → video-tasks-bulk.
const SRC_QUEUE = process.env.DRAIN_SRC_QUEUE || MAIN_QUEUE;
const DST_QUEUE = process.env.DRAIN_DST_QUEUE || BULK_QUEUE;

// Every message we receive goes invisible for this long. That is what lets us page through the whole
// queue without re-reading the same messages forever. In --commit we hand the interactive messages
// straight back (visibility 0) so the worker can pick them up at once — they are the whole point.
const VISIBILITY_SEC = 120;
const BATCH = 32; // Azure's per-receive maximum

async function drain() {
    const cs = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (!cs) {
        console.error('[drain] AZURE_STORAGE_CONNECTION_STRING not set. Aborting.');
        process.exit(1);
    }

    const svc = QueueServiceClient.fromConnectionString(cs);
    const interactiveQ = svc.getQueueClient(SRC_QUEUE);
    const bulkQ = svc.getQueueClient(DST_QUEUE);
    await bulkQ.createIfNotExists();

    const before = (await interactiveQ.getProperties()).approximateMessagesCount;
    console.log(`[drain] account: ${svc.accountName}  |  mode: ${COMMIT ? 'COMMIT' : 'DRY RUN'}`);
    console.log(`[drain] ${SRC_QUEUE} depth before: ${before}`);

    const seen = new Set();
    // Messages we are LEAVING on the interactive lane, keyed by id so a re-receive just refreshes the
    // pop receipt rather than double-counting. Receiving a message hides it, so these have to be
    // handed back explicitly at the end — un-hiding them inside the loop is pointless, because the
    // next receiveMessages() simply hides them again and the last one would never be undone.
    const keptMsgs = new Map();
    let moved = 0, unparseable = 0;

    while (true) {
        const { receivedMessageItems: msgs } = await interactiveQ.receiveMessages({
            numberOfMessages: BATCH,
            visibilityTimeout: VISIBILITY_SEC,
        });
        if (msgs.length === 0) break;

        let fresh = 0;

        for (const msg of msgs) {
            const isNew = !seen.has(msg.messageId);

            let data = null;
            try {
                data = JSON.parse(Buffer.from(msg.messageText, 'base64').toString());
            } catch {
                data = null; // unparseable — see below
            }

            // Anything that is not town hall stays on the interactive lane: a `video` message (exactly
            // what we are un-blocking), and anything unparseable, which is the worker's to dead-letter,
            // not ours to guess at. Always refresh the pop receipt — the newest one is the only one
            // that will still be valid when we hand these back.
            if (data?.type !== 'townhall') {
                if (isNew) { seen.add(msg.messageId); fresh++; if (data === null) unparseable++; }
                keptMsgs.set(msg.messageId, { popReceipt: msg.popReceipt, messageText: msg.messageText });
                continue;
            }

            if (!isNew) continue; // defensive: town hall is deleted on move, so it shouldn't reappear
            seen.add(msg.messageId);
            fresh++;

            if (!COMMIT) { moved++; continue; }

            // Send to bulk BEFORE deleting from the interactive lane. If the delete then fails we get
            // a duplicate, which is harmless — the worker is idempotent (a post that already has an
            // hls_url acks without re-transcoding). Deleting first would risk losing the task outright.
            await bulkQ.sendMessage(msg.messageText);
            await interactiveQ.deleteMessage(msg.messageId, msg.popReceipt);
            moved++;
        }

        // A whole batch of nothing new → the queue is drained.
        if (fresh === 0) break;
    }

    // Hand the interactive messages back NOW rather than letting them serve out VISIBILITY_SEC. These
    // are the stuck uploads this whole exercise is about; making them wait another two minutes would
    // defeat the point. (Dry runs leave them hidden — nothing was changed, so nothing is owed back.)
    const kept = keptMsgs.size;
    if (COMMIT) {
        for (const [messageId, { popReceipt, messageText }] of keptMsgs) {
            await interactiveQ.updateMessage(messageId, popReceipt, messageText, 0)
                .catch((e) => console.warn(`[drain] could not un-hide ${messageId} (it will reappear in ` +
                                           `${VISIBILITY_SEC}s regardless): ${e.message}`));
        }
    }

    console.log(`[drain] town hall ${COMMIT ? 'moved to' : 'would move to'} ${DST_QUEUE}: ${moved}`);
    console.log(`[drain] left on ${SRC_QUEUE} (videos etc.): ${kept}`);
    if (unparseable) console.log(`[drain] left for the worker to dead-letter: ${unparseable}`);

    if (COMMIT) {
        console.log(`[drain] ${SRC_QUEUE} depth after: ${(await interactiveQ.getProperties()).approximateMessagesCount}`);
        console.log(`[drain] ${DST_QUEUE} depth after: ${(await bulkQ.getProperties()).approximateMessagesCount}`);
    } else {
        console.log('[drain] DRY RUN — nothing moved. Re-run with --commit to apply.');
        console.log(`[drain] NOTE: messages read during this dry run stay hidden for ${VISIBILITY_SEC}s ` +
                    'before the worker sees them again.');
    }
}

drain().catch((err) => {
    console.error('[drain] failed:', err.message);
    process.exit(1);
});
