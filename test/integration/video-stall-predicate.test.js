import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { db, createUser, truncateAll, closeDb } from '../helpers/db.js';
import {
  stalledVideoWhere,
  GRACE_MS,
  RETRY_AFTER_MS,
  HARD_STUCK_MS,
  MAX_ATTEMPTS,
} from '../../utils/video-stall.js';

// The reconciliation sweep re-queues stalled videos; the pipeline monitor pages about them. On
// 2026-07-14 they each had their own filter, and the filters disagreed: the monitor counted a video
// from 30m old regardless of last_attempt_at, while the sweep refused to re-queue one whose attempt
// sat between 30m and 3h ago (unless the video was already 4h+ old). We paged, hourly, about videos
// nothing was allowed to fix. The alert said "15 videos" while only 2 were in the queue.
//
// Both now read stalledVideoWhere(). These tests run it against a REAL Postgres, on purpose:
// the whole class of bug here is SQL-semantic, not JS-semantic. Prisma compiles `notIn` on a
// nullable column to a bare `NOT IN (...)`, and `NULL NOT IN (...)` is NULL in Postgres — so NULL
// rows vanish from the result. That cannot be caught by asserting on a where-object literal; it only
// shows up when the query actually runs.
//
// The property that matters: the predicate is TOTAL over last_attempt_at. Every video is either
// re-queueable or legitimately mid-transcode. There is no third state for one to hide in.

const NOW = new Date('2026-07-14T12:00:00Z').getTime();
const ago = (ms) => new Date(NOW - ms);
const MIN = 60 * 1000;

let channelId;

async function makeVideo(title, overrides = {}) {
  const v = await db.video.create({
    data: {
      channel_id: channelId,
      title,
      raw_video_url: `https://blob.example/videos-raw/${title}.mp4`,
      hls_url: null,
      created_at: ago(2 * 60 * MIN), // 2h old — safely past GRACE unless a case overrides it
      ...overrides,
    },
    select: { video_id: true, title: true },
  });
  return v;
}

/** Titles the predicate says are recoverably stalled — i.e. what the sweep re-queues AND the monitor counts. */
async function stalledTitles() {
  const rows = await db.video.findMany({
    where: stalledVideoWhere(NOW),
    select: { title: true },
    orderBy: { title: 'asc' },
  });
  return rows.map((r) => r.title);
}

beforeAll(async () => {
  await truncateAll();
  const user = await createUser();
  const channel = await db.channel.create({
    data: { user_id: user.user_id, handle: `stalltest${Date.now()}`, display_name: 'Stall Test' },
    select: { channel_id: true },
  });
  channelId = channel.channel_id;
});

afterAll(async () => {
  await closeDb();
});

describe('stalledVideoWhere — the shared sweep/monitor predicate', () => {
  beforeEach(async () => {
    await db.video.deleteMany({ where: { channel_id: channelId } });
  });

  // ── The regression that caused the page ────────────────────────────────────────────────────
  it('re-queues a video whose attempt landed in the OLD 30m–3h dead-zone', async () => {
    // Attempted 90m ago, created 2h ago. Under the old sweep this matched NO branch (last_attempt_at
    // was newer than the 3h stale cutoff, and the video wasn't 4h+ old yet) — so it was never
    // re-queued, while the monitor happily paged about it. This is the exact hole the 13 missing
    // videos fell into.
    await makeVideo('deadzone', { last_attempt_at: ago(90 * MIN), processing_status: 'processing' });
    expect(await stalledTitles()).toEqual(['deadzone']);
  });

  it('is TOTAL over last_attempt_at — no value escapes both re-queue and in-progress', async () => {
    // Sweep the whole space in 5-minute steps out to 4h. Every video is 2h old (past GRACE), so the
    // ONLY thing deciding its fate is last_attempt_at. Each must be either re-queueable (quiet past
    // RETRY_AFTER) or legitimately mid-transcode (quieter than that) — never neither.
    const steps = [];
    for (let m = 0; m <= 240; m += 5) steps.push(m);
    for (const m of steps) {
      await makeVideo(`t${String(m).padStart(3, '0')}`, {
        last_attempt_at: ago(m * MIN),
        processing_status: 'processing',
      });
    }

    const stalled = new Set(await stalledTitles());
    const orphans = [];
    for (const m of steps) {
      const title = `t${String(m).padStart(3, '0')}`;
      // STRICTLY older: the predicate uses `lt`, so an attempt exactly RETRY_AFTER_MS old still
      // counts as in-progress. That boundary is deliberately conservative and opens no hole — the
      // sweep runs every 15m, so the video is simply picked up on the next tick.
      const shouldRequeue = m * MIN > RETRY_AFTER_MS;
      const isStalled = stalled.has(title);
      if (shouldRequeue !== isStalled) orphans.push(`${title} (attempt ${m}m ago): expected stalled=${shouldRequeue}, got ${isStalled}`);
    }
    expect(orphans).toEqual([]);
  });

  // ── Never-attempted (the lost-enqueue case) ───────────────────────────────────────────────
  it('re-queues a never-attempted video once it is past the grace window', async () => {
    await makeVideo('lost-enqueue', { last_attempt_at: null, created_at: ago(GRACE_MS + 5 * MIN) });
    expect(await stalledTitles()).toEqual(['lost-enqueue']);
  });

  it('leaves a never-attempted video alone while it is still inside the grace window', async () => {
    // A fresh upload is not "stuck", it's new. Counting it would page on every single upload.
    await makeVideo('just-uploaded', { last_attempt_at: null, created_at: ago(GRACE_MS - 5 * MIN) });
    expect(await stalledTitles()).toEqual([]);
  });

  // ── Legitimately in flight ────────────────────────────────────────────────────────────────
  it('leaves a video that is actively transcoding alone', async () => {
    // Picked up 10m ago. A long chunked transcode can genuinely still be running — re-queueing it
    // would duplicate work, and counting it would be a false alarm.
    await makeVideo('in-flight', { last_attempt_at: ago(10 * MIN), processing_status: 'processing' });
    expect(await stalledTitles()).toEqual([]);
  });

  // ── The backstop ──────────────────────────────────────────────────────────────────────────
  it('still catches a video with a FUTURE last_attempt_at via the hard-stuck backstop', async () => {
    // Clock skew / corrupt write. "older than X" is false forever for a future timestamp, so without
    // the created_at backstop this row would hide from the sweep permanently.
    await makeVideo('future-ts', {
      last_attempt_at: new Date(NOW + 60 * MIN),
      created_at: ago(HARD_STUCK_MS + 10 * MIN),
    });
    expect(await stalledTitles()).toEqual(['future-ts']);
  });

  // ── Exclusions: things we must NOT page about ─────────────────────────────────────────────
  it('excludes videos that are already streamable, banned, unfinished uploads, errored, or exhausted', async () => {
    await makeVideo('has-hls', { hls_url: 'https://cdn/master.m3u8', last_attempt_at: ago(90 * MIN) });
    await makeVideo('banned', { status: 'banned', last_attempt_at: ago(90 * MIN) });
    await makeVideo('never-uploaded', { raw_video_url: 'pending_upload', last_attempt_at: ago(90 * MIN) });
    // 'error' = the worker gave up and the creator can SEE it failed. Surfaced, not churned.
    await makeVideo('errored', { processing_status: 'error', last_attempt_at: ago(90 * MIN) });
    await makeVideo('exhausted', { processing_attempts: MAX_ATTEMPTS, last_attempt_at: ago(90 * MIN) });
    // ...and one genuinely stalled video, so a filter that wrongly excluded EVERYTHING would fail too.
    await makeVideo('genuinely-stalled', { last_attempt_at: ago(90 * MIN) });

    expect(await stalledTitles()).toEqual(['genuinely-stalled']);
  });

  it('counts a video one attempt short of exhaustion (it is still recoverable)', async () => {
    await makeVideo('last-chance', {
      processing_attempts: MAX_ATTEMPTS - 1,
      last_attempt_at: ago(90 * MIN),
    });
    expect(await stalledTitles()).toEqual(['last-chance']);
  });
});
