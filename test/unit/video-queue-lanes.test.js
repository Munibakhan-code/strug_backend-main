import { describe, it, expect, vi, beforeEach } from 'vitest';

// One worker drains two queues. `video-tasks` is interactive (a user is watching a progress bar);
// `video-tasks-bulk` is best-effort (a town hall post already plays its raw media_url). They were a
// single FIFO until 2026-07-14, when a ~230-post town hall burst head-of-line-blocked the Videos
// vertical for hours and paged us with "15 videos past 30m without HLS". The worker was healthy —
// the backlog was just in front of the videos.
//
// These tests pin the two properties that make that unrepeatable, and that a refactor would quietly
// break: town hall work lands on the BULK queue, and `lane` never reaches the worker on the wire
// (the worker infers the lane from which queue it read, so a `lane` in the payload could disagree).

const sendMessage = vi.fn();
const createIfNotExists = vi.fn();
const getQueueClient = vi.fn();

vi.mock('@azure/storage-queue', () => ({
  QueueServiceClient: {
    fromConnectionString: () => ({ getQueueClient }),
  },
}));

// Which queue did we send to, and what was actually on the wire?
function sentTo(queueName) {
  const call = getQueueClient.mock.calls.findIndex(([n]) => n === queueName);
  return call !== -1;
}
function decodePayload(i = 0) {
  return JSON.parse(Buffer.from(sendMessage.mock.calls[i][0], 'base64').toString('utf8'));
}

let pushToVideoQueue;

beforeEach(async () => {
  vi.clearAllMocks();
  getQueueClient.mockImplementation(() => ({ createIfNotExists, sendMessage }));
  process.env.AZURE_STORAGE_CONNECTION_STRING = 'UseDevelopmentStorage=true';
  // The module caches a client per queue name at first use — reset it between cases.
  vi.resetModules();
  ({ pushToVideoQueue } = await import('../../utils/azure-queue.js'));
});

describe('video queue lanes', () => {
  it('routes a task with no lane to the interactive queue', async () => {
    await pushToVideoQueue(42, 'raw-42.mp4');
    expect(sentTo('video-tasks')).toBe(true);
    expect(sentTo('video-tasks-bulk')).toBe(false);
  });

  it('routes a bulk-lane task to the bulk queue', async () => {
    await pushToVideoQueue(8702, 'post-8702.mp4', { type: 'townhall', lane: 'bulk' });
    expect(sentTo('video-tasks-bulk')).toBe(true);
    expect(sentTo('video-tasks')).toBe(false);
  });

  // The regression that caused the outage: town hall video on the interactive lane. A Videos upload
  // is unwatchable until it transcodes; a town hall post is not. If a future enqueue site forgets
  // `lane: 'bulk'`, a burst of social posts can starve real uploads again.
  it('keeps town hall video off the interactive lane', async () => {
    await pushToVideoQueue(8703, 'post-8703.mp4', { type: 'townhall', lane: 'bulk' });
    expect(sentTo('video-tasks')).toBe(false);
  });

  it('forwards vertical metadata but never puts `lane` on the wire', async () => {
    await pushToVideoQueue(8705, 'post-8705.mp4', {
      type: 'townhall',
      container: 'social-posts',
      lane: 'bulk',
    });
    const payload = decodePayload();
    expect(payload).toEqual({
      videoId: 8705,
      blobName: 'post-8705.mp4',
      type: 'townhall',
      container: 'social-posts',
    });
    expect(payload).not.toHaveProperty('lane');
  });

  it('an unknown lane value falls back to interactive rather than a phantom queue', async () => {
    await pushToVideoQueue(7, 'raw-7.mp4', { lane: 'nonsense' });
    expect(sentTo('video-tasks')).toBe(true);
    expect(getQueueClient.mock.calls.map(([n]) => n)).not.toContain('nonsense');
  });
});
