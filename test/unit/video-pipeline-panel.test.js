import { describe, it, expect } from 'vitest';
import { heartbeatState } from '../../routes/board-admin-engineering-routes.js';
import { RETRY_AFTER_MS } from '../../utils/video-stall.js';

// The panel exists to answer one question the old Engineering view could not:
// IS THIS VIDEO GRINDING, OR IS IT DEAD?
//
// On 2026-07-14 a 10-hour upload spent hours failing to fan out while the dashboard said, simply,
// "1 stuck job" — indistinguishable from a video that was transcoding perfectly well. The two are
// only tellable apart because the worker now writes a progress heartbeat into last_attempt_at
// (strug_worker#129); before that it was stamped once at the start of a run and never moved.

const NOW = 1_784_000_000_000;
const agoMin = (m) => new Date(NOW - m * 60_000);

describe('heartbeatState', () => {
    it('a worker reporting progress reads as grinding, however long it has been running', () => {
        // The whole point: a 10-hour transcode is NOT stuck. Age of the upload is irrelevant —
        // only the age of the last heartbeat matters.
        expect(heartbeatState(agoMin(1), NOW)).toBe('grinding');
        expect(heartbeatState(agoMin(14), NOW)).toBe('grinding');
    });

    it('flags a worker that has gone quiet, before the sweep would act on it', () => {
        // Past 3 missed 5-minute stamps. Suspicious, but the sweep hasn't re-queued it yet — this is
        // the window where a human looking at the panel can catch a wedge EARLY.
        expect(heartbeatState(agoMin(20), NOW)).toBe('silent');
        expect(heartbeatState(agoMin(44), NOW)).toBe('silent');
    });

    it('marks it stalled at exactly the point the sweep re-queues and the monitor pages', () => {
        // Must agree with the shared predicate — a panel that drew its own line would be a second
        // definition of "stalled", which is precisely how the alert started lying last time.
        const justPast = new Date(NOW - RETRY_AFTER_MS - 1000);
        expect(heartbeatState(justPast, NOW)).toBe('stalled');
    });

    it('distinguishes a LOST ENQUEUE from a quiet worker', () => {
        // null last_attempt_at means nothing ever picked it up — a different failure (the enqueue
        // was lost) needing a different fix than "the worker died mid-run".
        expect(heartbeatState(null, NOW)).toBe('no-heartbeat');
    });
});
