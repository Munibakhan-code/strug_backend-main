import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { db, createUser, truncateAll, closeDb } from '../helpers/db.js';
import {
  stalledTownHallPostWhere,
  pendingTownHallPostWhere,
  GRACE_MS,
  RETRY_AFTER_MS,
  HARD_STUCK_MS,
  MAX_ATTEMPTS,
} from '../../utils/video-stall.js';

// Town hall posts ride the same transcode pipeline as videos (#415), and their sweep carried every
// defect the video sweep had, plus one of its own. Against a REAL Postgres, because the load-bearing
// behaviour here is SQL-semantic: `processing_status` is NULLABLE on town_hall_post, and Prisma
// compiles `notIn` to a bare `NOT IN (...)`, so `NULL NOT IN (...)` is NULL and NULL rows are
// silently EXCLUDED. That exclusion is DELIBERATE (see below) — and no assertion on a where-object
// literal could tell you whether it actually happens.

const NOW = new Date('2026-07-14T12:00:00Z').getTime();
const ago = (ms) => new Date(NOW - ms);
const MIN = 60 * 1000;

let userId;

async function makePost(content, overrides = {}) {
  return db.town_hall_post.create({
    data: {
      user_id: userId,
      content,
      media_type: 'video',
      media_url: `https://blob.example/social-posts/${content}.mp4`,
      hls_url: null,
      processing_status: 'pending',
      created_at: ago(2 * 60 * MIN), // 2h old — past GRACE unless a case overrides it
      ...overrides,
    },
    select: { post_id: true },
  });
}

async function stalledContents() {
  const rows = await db.town_hall_post.findMany({
    where: stalledTownHallPostWhere(NOW),
    select: { content: true },
    orderBy: { content: 'asc' },
  });
  return rows.map((r) => r.content);
}

beforeAll(async () => {
  await truncateAll();
  const user = await createUser();
  userId = user.user_id;
});

afterAll(async () => {
  await closeDb();
});

describe('stalledTownHallPostWhere', () => {
  beforeEach(async () => {
    await db.town_hall_post.deleteMany({ where: { user_id: userId } });
  });

  // ── The three holes this closes ───────────────────────────────────────────────────────────
  it('re-queues a post whose attempt landed in the old 30m–3h dead-zone', async () => {
    await makePost('deadzone', { last_attempt_at: ago(90 * MIN), processing_status: 'processing' });
    expect(await stalledContents()).toEqual(['deadzone']);
  });

  it('still catches a post with a FUTURE last_attempt_at (it was invisible forever)', async () => {
    // `lt: staleCutoff` is never true for a future timestamp, so a clock-skewed post could never be
    // re-queued. Ever. This is the ONLY thing the hard-stuck backstop is for.
    await makePost('future-ts', {
      last_attempt_at: new Date(NOW + 60 * MIN),
      created_at: ago(HARD_STUCK_MS + 10 * MIN),
    });
    expect(await stalledContents()).toEqual(['future-ts']);
  });

  // ── THE ONE THAT COST US THE TOWN HALL LANE ──────────────────────────────────────────────
  it('does NOT re-queue an OLD post that is heartbeating — age is not evidence of a stall', async () => {
    // The backstop was written as `created_at < now - HARD_STUCK_MS`. As an OR branch that fires
    // regardless of last_attempt_at, so the "fresh heartbeat → leave it alone" case became
    // unreachable for anything older than four hours: such a post was permanently stalled BY
    // DEFINITION, re-queued on every 15-minute sweep run forever, with its processing_status reset
    // to 'pending' each time.
    //
    // Prod, 2026-07-14: 17 posts, all 26–30h old, all heartbeating — ~68 duplicate messages an hour,
    // ~680 sitting in the bulk lane, and the panel reporting 0 in-flight while post 5983 was
    // mid-encode with a 3-minute-old heartbeat. This test is that post.
    await makePost('old-but-grinding', {
      created_at: ago(30 * 60 * MIN),           // 30 hours old, like the real ones
      last_attempt_at: ago(3 * MIN),            // ...and reporting progress 3 minutes ago
      processing_status: 'processing',
    });
    expect(await stalledContents()).toEqual([]);
  });

  it('DOES re-queue an old post once its heartbeat actually goes quiet', async () => {
    // The other half of the same coin — the fix must not blind the sweep to a genuinely dead worker.
    await makePost('old-and-dead', {
      created_at: ago(30 * 60 * MIN),
      last_attempt_at: ago(RETRY_AFTER_MS + 5 * MIN),
      processing_status: 'processing',
    });
    expect(await stalledContents()).toEqual(['old-and-dead']);
  });

  it('does NOT re-queue a brand-new post — the create path just enqueued it', async () => {
    // THE loud one. The create path enqueues and sets processing_status='pending' but never stamps
    // last_attempt_at. So a fresh post has last_attempt_at NULL, and the old sweep matched it on the
    // `{ last_attempt_at: null }` branch within 15 minutes — re-enqueueing on top of the enqueue that
    // had just fired. EVERY town hall video was double-queued as a matter of course, which is exactly
    // the churn that buried the video lane on 2026-07-14.
    await makePost('just-posted', { last_attempt_at: null, created_at: ago(GRACE_MS - 5 * MIN) });
    expect(await stalledContents()).toEqual([]);
  });

  it('DOES re-queue a never-attempted post once the grace window has passed (a genuinely lost enqueue)', async () => {
    await makePost('lost-enqueue', { last_attempt_at: null, created_at: ago(GRACE_MS + 5 * MIN) });
    expect(await stalledContents()).toEqual(['lost-enqueue']);
  });

  // ── Totality: no last_attempt_at value may escape ─────────────────────────────────────────
  it('is TOTAL over last_attempt_at — no value escapes both re-queue and in-progress', async () => {
    const steps = [];
    for (let m = 0; m <= 240; m += 5) steps.push(m);
    for (const m of steps) {
      await makePost(`t${String(m).padStart(3, '0')}`, {
        last_attempt_at: ago(m * MIN),
        processing_status: 'processing',
      });
    }
    const stalled = new Set(await stalledContents());
    const orphans = [];
    for (const m of steps) {
      const c = `t${String(m).padStart(3, '0')}`;
      const shouldRequeue = m * MIN > RETRY_AFTER_MS; // strictly older; `lt` semantics
      if (shouldRequeue !== stalled.has(c)) {
        orphans.push(`${c} (attempt ${m}m ago): expected ${shouldRequeue}, got ${stalled.has(c)}`);
      }
    }
    expect(orphans).toEqual([]);
  });

  // ── The DELIBERATE NULL exclusion ─────────────────────────────────────────────────────────
  it('EXCLUDES pre-#415 posts whose processing_status is NULL — on purpose', async () => {
    // This is the one that looks like the Prisma NULL bug and is not. A post predating the town hall
    // transcode feature has a NULL processing_status and plays its raw media_url perfectly well.
    // Pulling them in would drag the ENTIRE historical catalogue into the queue as an unrequested
    // backfill. `notIn` on a nullable column drops NULL rows, and here that is the feature.
    await makePost('pre-415-legacy', { processing_status: null, last_attempt_at: ago(90 * MIN) });
    await makePost('modern-stalled', { last_attempt_at: ago(90 * MIN) });
    expect(await stalledContents()).toEqual(['modern-stalled']);
  });

  // ── Exclusions ────────────────────────────────────────────────────────────────────────────
  it('excludes posts that are done, banned, errored, exhausted, non-video, or media-less', async () => {
    await makePost('has-hls', { hls_url: 'https://cdn/master.m3u8', last_attempt_at: ago(90 * MIN) });
    await makePost('banned', { is_banned: true, last_attempt_at: ago(90 * MIN) });
    await makePost('errored', { processing_status: 'error', last_attempt_at: ago(90 * MIN) });
    await makePost('done', { processing_status: 'done', last_attempt_at: ago(90 * MIN) });
    await makePost('exhausted', { processing_attempts: MAX_ATTEMPTS, last_attempt_at: ago(90 * MIN) });
    await makePost('an-image', { media_type: 'image', last_attempt_at: ago(90 * MIN) });
    await makePost('no-media', { media_url: null, last_attempt_at: ago(90 * MIN) });
    await makePost('genuinely-stalled', { last_attempt_at: ago(90 * MIN) });

    expect(await stalledContents()).toEqual(['genuinely-stalled']);
  });
});

// ── pendingTownHallPostWhere ────────────────────────────────────────────────────────────────
//
// The denominator for the bulk queue lane. The panel counted prisma.video only, so a bulk depth of
// ~490 against 20 stalled posts was uninterpretable: 490 real posts and "20 posts + 470 duplicate
// re-queues" look identical from outside, and want opposite fixes. `bulk depth - pendingTownHall`
// is the duplicate load — but only if this predicate is an honest superset of the stalled one.
describe('pendingTownHallPostWhere', () => {
  beforeEach(async () => {
    await db.town_hall_post.deleteMany({ where: { user_id: userId } });
  });

  async function pendingContents() {
    const rows = await db.town_hall_post.findMany({
      where: pendingTownHallPostWhere(),
      select: { content: true },
      orderBy: { content: 'asc' },
    });
    return rows.map((r) => r.content);
  }

  it('EXCLUDES pre-#415 NULL-status posts — the same deliberate exclusion, inherited', async () => {
    // The load-bearing one. This count drives an operator's read of the queue, so if it swept in the
    // historical catalogue it would report thousands of "pending" posts that nobody ever asked to
    // transcode — and the obvious response to that number is to go backfill them, recreating the
    // 2026-07-14 flood. It shares the exclusion by construction (stalled spreads this), not by a
    // second copy of the predicate that could drift away from it.
    await makePost('pre-415-legacy', { processing_status: null });
    await makePost('modern-pending', { processing_status: 'pending' });
    expect(await pendingContents()).toEqual(['modern-pending']);
  });

  it('counts work the STALLED predicate deliberately skips — young posts and exhausted ones', async () => {
    // A post uploaded 10 seconds ago has a real message sitting in the bulk queue, and a post that
    // burned MAX_ATTEMPTS without being terminalized is real outstanding work too. Neither is
    // "stalled" (one is too young to judge, the other the sweep has given up on) — but both are in
    // the denominator. Gating pending on age or attempts would understate it and manufacture a
    // phantom duplicate gap, which is precisely the wrong diagnosis.
    await makePost('just-posted', { created_at: ago(1 * MIN), last_attempt_at: null });
    await makePost('exhausted', { processing_attempts: MAX_ATTEMPTS, last_attempt_at: ago(90 * MIN) });
    await makePost('genuinely-stalled', { last_attempt_at: ago(90 * MIN) });

    expect(await pendingContents()).toEqual(['exhausted', 'genuinely-stalled', 'just-posted']);
    expect(await stalledContents()).toEqual(['genuinely-stalled']);
  });

  it('excludes posts that are done, banned, errored, already-rendered, non-video, or media-less', async () => {
    await makePost('has-hls', { hls_url: 'https://cdn/master.m3u8' });
    await makePost('banned', { is_banned: true });
    await makePost('errored', { processing_status: 'error' });
    await makePost('done', { processing_status: 'done' });
    await makePost('an-image', { media_type: 'image' });
    await makePost('no-media', { media_url: null });
    await makePost('really-pending', {});

    expect(await pendingContents()).toEqual(['really-pending']);
  });

  it('is a strict SUPERSET of stalled — otherwise depth minus pending is meaningless', async () => {
    // The panel subtracts one from the other. If a post could ever be stalled without being pending,
    // that subtraction would under-report duplicates (or go negative) and quietly mislead whoever is
    // reading the panel mid-incident.
    for (const m of [0, 20, 45, 90, 200, 400]) {
      await makePost(`p${String(m).padStart(3, '0')}`, {
        last_attempt_at: ago(m * MIN),
        created_at: ago((m + 60) * MIN),
        processing_status: 'processing',
      });
    }
    const pending = new Set(await pendingContents());
    const stalled = await stalledContents();

    expect(stalled.length).toBeGreaterThan(0);          // the check would pass vacuously otherwise
    expect(stalled.filter((c) => !pending.has(c))).toEqual([]);
  });
});
