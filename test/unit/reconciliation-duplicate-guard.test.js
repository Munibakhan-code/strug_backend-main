import { describe, it, expect } from 'vitest';
import { enqueueLikelyLost, MAX_QUEUED_WAIT_MS } from '../../workers/video-reconciliation.js';

// The sweep recovers LOST enqueues. Its trigger (last_attempt_at null/stale) cannot distinguish "the
// enqueue vanished" from "this video is waiting in a deep queue the worker hasn't reached yet", so
// something has to break the tie. THREE attempts, and the first two each caused the other's bug:
//
//   1. No guard (2026-07-21) — OVER-QUEUEING. ~105 videos produced ~140 msg/hour; queue 151 -> 757
//      in 12h against ~5 real videos/hour. Depth stopped being a usable diagnostic.
//
//   2. Lane depth vs outstanding count (2026-07-22 am) — STARVATION. A burst of new uploads made
//      "lane holds 254 message(s) for 132 outstanding video(s) — skipping" fire every 15 min for
//      hours. Backlog grew 74 -> 156, every worker dequeue was a NEW video, zero old ones recovered.
//      Queue depth cannot say WHOSE messages it holds.
//
//   3. Per-video, but with a 45m clock (2026-07-22 pm) — OVER-QUEUEING AGAIN. RETRY_AFTER_MS assumes
//      a message is consumed within 45 minutes. With a 570-deep lane draining at ~15/hour the true
//      wait is ~38 HOURS, so every video aged out while still queued and was re-pushed. Lane went
//      328 -> 570 -> 769 in ninety minutes.
//
// The lesson in (3) is that ANY fixed horizon is wrong, because the correct value is queue latency
// and that varies by orders of magnitude. So compare the two stamps instead:
//   last_enqueued_at (we pushed) vs last_attempt_at (a worker picked it up).
// Un-consumed ⇒ still queued ⇒ wait, no matter how deep. Consumed but still stalled ⇒ recover.
//
// These tests pin all three failure modes at once.

const NOW = Date.UTC(2026, 6, 22, 13, 0, 0);
const ago = (ms) => new Date(NOW - ms);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

describe('enqueueLikelyLost', () => {
    it('recovers a video that was never enqueued', () => {
        expect(enqueueLikelyLost(null, null, NOW)).toBe(true);
        expect(enqueueLikelyLost(undefined, ago(2 * HOUR), NOW)).toBe(true);
    });

    it('WAITS on a message that has not been consumed — however long it has queued (bug 3)', () => {
        // The 45m-horizon version re-pushed all of these. A deep lane is not evidence of loss.
        expect(enqueueLikelyLost(ago(1 * MIN), null, NOW)).toBe(false);
        expect(enqueueLikelyLost(ago(46 * MIN), null, NOW)).toBe(false);
        expect(enqueueLikelyLost(ago(6 * HOUR), null, NOW)).toBe(false);
        expect(enqueueLikelyLost(ago(23 * HOUR), null, NOW)).toBe(false);
    });

    it('WAITS when the last pickup predates our push — that push is still outstanding', () => {
        // Worker picked it up 5h ago, we pushed again 2h ago: the newer message is still queued.
        expect(enqueueLikelyLost(ago(2 * HOUR), ago(5 * HOUR), NOW)).toBe(false);
    });

    it('RECOVERS when a worker consumed our push and the video is still stalled', () => {
        // Pushed 5h ago, picked up 2h ago, yet still un-transcoded ⇒ that attempt died.
        expect(enqueueLikelyLost(ago(5 * HOUR), ago(2 * HOUR), NOW)).toBe(true);
    });

    it('treats an exactly-simultaneous stamp as consumed, not queued', () => {
        // Ordering is unknowable at equal timestamps; recovery is the safe side.
        const t = ago(3 * HOUR);
        expect(enqueueLikelyLost(t, t, NOW)).toBe(true);
    });

    it('backstops a push that never became a deliverable message', () => {
        // The one case the comparison cannot see: send silently dropped, or the message expired
        // unread. Without this the video waits forever.
        expect(enqueueLikelyLost(ago(MAX_QUEUED_WAIT_MS - MIN), null, NOW)).toBe(false);
        expect(enqueueLikelyLost(ago(MAX_QUEUED_WAIT_MS), null, NOW)).toBe(true);
        expect(enqueueLikelyLost(ago(MAX_QUEUED_WAIT_MS + HOUR), null, NOW)).toBe(true);
    });

    it('keeps the backstop far above realistic queue latency (else bug 3 returns)', () => {
        // 45m was catastrophically short. Guard the ORDER OF MAGNITUDE, not the exact value.
        expect(MAX_QUEUED_WAIT_MS).toBeGreaterThanOrEqual(12 * HOUR);
    });

    it('is INDEPENDENT of lane depth — bug 2 cannot recur through this function', () => {
        // It takes no depth argument at all, so a busy queue can never starve recovery.
        expect(enqueueLikelyLost.length).toBeLessThanOrEqual(4); // (enq, att, now, backstop?)
        expect(enqueueLikelyLost(null, null, NOW)).toBe(true);
    });

    it('accepts ISO strings as well as Dates — Prisma returns Date, JSON returns string', () => {
        expect(enqueueLikelyLost(ago(5 * HOUR).toISOString(), ago(2 * HOUR).toISOString(), NOW)).toBe(true);
        expect(enqueueLikelyLost(ago(2 * HOUR).toISOString(), ago(5 * HOUR).toISOString(), NOW)).toBe(false);
    });

    it('recovers on a corrupt or future stamp rather than stranding the video', () => {
        expect(enqueueLikelyLost('not-a-date', null, NOW)).toBe(true);
        expect(enqueueLikelyLost(NaN, null, NOW)).toBe(true);
        expect(enqueueLikelyLost(new Date(NOW + HOUR), null, NOW)).toBe(true);
    });

    it('ignores a corrupt last_attempt_at by treating the push as still queued', () => {
        // A bad pickup stamp must not be read as "consumed" — that would re-push a live message.
        expect(enqueueLikelyLost(ago(2 * HOUR), 'not-a-date', NOW)).toBe(false);
    });
});
