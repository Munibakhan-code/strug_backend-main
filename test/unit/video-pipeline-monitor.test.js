import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    evaluatePipelineHealth,
    checkVideoPipelineHealth,
    __resetMonitorStateForTest,
} from '../../utils/video-pipeline-monitor.js';

const MIN = 60 * 1000;
const now = 10_000 * MIN; // arbitrary fixed clock
const bootAt = now - 90 * MIN; // booted long enough ago that boot grace has lapsed

// Healthy baseline: sweep succeeded a minute ago, no stuck videos.
const base = {
    now,
    bootAt,
    lastSweepSuccessAt: now - 1 * MIN,
    stuckCount: 0,
    oldestStuckMs: null,
};

describe('evaluatePipelineHealth — sweep heartbeat', () => {
    it('healthy when the sweep succeeded recently and nothing is stuck', () => {
        const r = evaluatePipelineHealth(base);
        expect(r.healthy).toBe(true);
        expect(r.reasons).toEqual([]);
    });

    it('alerts when the sweep heartbeat goes stale (the null-filter regression)', () => {
        const r = evaluatePipelineHealth({ ...base, lastSweepSuccessAt: now - 50 * MIN });
        expect(r.healthy).toBe(false);
        expect(r.reasons.join(' ')).toMatch(/reconciliation sweep last succeeded/);
    });

    it('alerts when the sweep never succeeded and boot grace has lapsed', () => {
        const r = evaluatePipelineHealth({ ...base, lastSweepSuccessAt: null });
        expect(r.healthy).toBe(false);
        expect(r.reasons.join(' ')).toMatch(/not completed a single successful run/);
    });

    it('stays quiet about a null heartbeat right after boot (still in grace)', () => {
        const r = evaluatePipelineHealth({ ...base, lastSweepSuccessAt: null, bootAt: now - 5 * MIN });
        expect(r.healthy).toBe(true);
    });
});

describe('evaluatePipelineHealth — stuck backlog', () => {
    it('alerts on a single very-old stuck video regardless of count', () => {
        const r = evaluatePipelineHealth({ ...base, stuckCount: 1, oldestStuckMs: 130 * MIN });
        expect(r.healthy).toBe(false);
        expect(r.reasons.join(' ')).toMatch(/oldest stuck 130m/);
    });

    it('alerts on a growing backlog even when none is past the hard ceiling', () => {
        const r = evaluatePipelineHealth({ ...base, stuckCount: 12, oldestStuckMs: 40 * MIN });
        expect(r.healthy).toBe(false);
        expect(r.reasons.join(' ')).toMatch(/12 video\(s\) past/);
    });

    it('tolerates a small, not-yet-old backlog (videos may still be transcoding)', () => {
        const r = evaluatePipelineHealth({ ...base, stuckCount: 3, oldestStuckMs: 40 * MIN });
        expect(r.healthy).toBe(true);
    });

    it('does not page stuck backlog when interactive queue depth shows healthy mass-upload backlog', () => {
        const r = evaluatePipelineHealth({
            ...base,
            stuckCount: 20,
            oldestStuckMs: 130 * MIN,
            interactiveQueueDepth: 40,
            bulkQueueDepth: 0,
        });
        expect(r.healthy).toBe(true);
        expect(r.reasons).toEqual([]);
    });

    it('still pages when stuck is high but queue depth is low (genuinely wedged)', () => {
        const r = evaluatePipelineHealth({
            ...base,
            stuckCount: 20,
            oldestStuckMs: 130 * MIN,
            interactiveQueueDepth: 0,
            bulkQueueDepth: 0,
        });
        expect(r.healthy).toBe(false);
        expect(r.reasons.join(' ')).toMatch(/wedged|backlog/);
    });

    it('reports both failures at once', () => {
        const r = evaluatePipelineHealth({ ...base, lastSweepSuccessAt: now - 50 * MIN, stuckCount: 20, oldestStuckMs: 130 * MIN });
        expect(r.reasons).toHaveLength(2);
    });
});

// Regression guard for the 2026-07-21 alert-fatigue incident. The pipeline genuinely broke that
// morning (an un-waved ACA fan-out throttled every long video), and the alert fired correctly — but
// it kept firing identically for ~20h afterwards while the worker was healthy and draining a ~500-deep
// recovery queue, because a video the worker hasn't REACHED yet has a null last_attempt_at and is
// indistinguishable, by backlog age alone, from one an abandoned worker left behind. Real outage and
// benign drain produced the same email, so the outage was lost in the noise.
describe('evaluatePipelineHealth — liveness gating (deep queue vs wedged)', () => {
    it('stays quiet about an old backlog while videos are still publishing (draining, not wedged)', () => {
        // The exact shape of the real alert: 17 stuck, oldest 449m — but 12 published in the window.
        const r = evaluatePipelineHealth({ ...base, stuckCount: 17, oldestStuckMs: 449 * MIN, recentCompletions: 12 });
        expect(r.healthy).toBe(true);
        expect(r.reasons).toEqual([]);
    });

    it('still pages when the backlog is old AND nothing has published — a real wedge', () => {
        const r = evaluatePipelineHealth({ ...base, stuckCount: 17, oldestStuckMs: 449 * MIN, recentCompletions: 0 });
        expect(r.healthy).toBe(false);
        expect(r.reasons.join(' ')).toMatch(/nothing has published in 30m/);
        expect(r.reasons.join(' ')).toMatch(/wedged/);
    });

    it('pages when one video outlasts the ceiling even though others publish around it', () => {
        const r = evaluatePipelineHealth({ ...base, stuckCount: 2, oldestStuckMs: 13 * 60 * MIN, recentCompletions: 9 });
        expect(r.healthy).toBe(false);
        expect(r.reasons.join(' ')).toMatch(/not progressing/);
    });

    it('mutes the volume ("backlog building") alert too while draining', () => {
        const r = evaluatePipelineHealth({ ...base, stuckCount: 25, oldestStuckMs: 40 * MIN, recentCompletions: 5 });
        expect(r.healthy).toBe(true);
    });

    it('falls back to the old paranoid behaviour when liveness is unknown (null)', () => {
        // A failed liveness read must never be mistaken for "healthy".
        const r = evaluatePipelineHealth({ ...base, stuckCount: 1, oldestStuckMs: 75 * MIN, recentCompletions: null });
        expect(r.healthy).toBe(false);
        expect(r.reasons.join(' ')).toMatch(/wedged/);
    });
});

describe('evaluatePipelineHealth — synthetic probe signal', () => {
    it('ignores the probe entirely when it is disabled', () => {
        const r = evaluatePipelineHealth({ ...base, probeEnabled: false, probeLastOk: false, probeReason: 'boom' });
        expect(r.healthy).toBe(true);
    });

    it('stays quiet when the probe is enabled but has not run yet', () => {
        const r = evaluatePipelineHealth({ ...base, probeEnabled: true, probeLastOk: null, probeLastAt: null });
        expect(r.healthy).toBe(true);
    });

    it('alerts when the probe last failed', () => {
        const r = evaluatePipelineHealth({ ...base, probeEnabled: true, probeLastOk: false, probeLastAt: now - 2 * MIN, probeReason: 'no HLS within 8m' });
        expect(r.healthy).toBe(false);
        expect(r.reasons.join(' ')).toMatch(/synthetic video probe failed.*no HLS within 8m/);
    });

    it('alerts when the probe last succeeded too long ago (stale)', () => {
        const r = evaluatePipelineHealth({ ...base, probeEnabled: true, probeLastOk: true, probeLastAt: now - 200 * MIN });
        expect(r.healthy).toBe(false);
        expect(r.reasons.join(' ')).toMatch(/synthetic video probe has not succeeded in 200m/);
    });

    it('is healthy when the probe recently succeeded', () => {
        const r = evaluatePipelineHealth({ ...base, probeEnabled: true, probeLastOk: true, probeLastAt: now - 5 * MIN });
        expect(r.healthy).toBe(true);
    });
});

describe('checkVideoPipelineHealth — alert de-duping + recovery', () => {
    beforeEach(() => __resetMonitorStateForTest());

    const deps = (over) => ({
        now,
        bootAt,
        getReconciliationHealth: () => ({ lastSweepSuccessAt: now - 1 * MIN }),
        readStuckBacklog: async () => ({ stuckCount: 0, oldestStuckMs: null }),
        readRecentCompletions: async () => 0, // injected so unit tests never touch the DB
        getSyntheticProbeHealth: () => ({ enabled: false, last: null }),
        syncStatusIncident: async () => {}, // no-op: don't touch the DB in unit tests
        send: vi.fn(),
        ...over,
    });

    it('does not alert while healthy', async () => {
        const d = deps();
        const r = await checkVideoPipelineHealth(d);
        expect(r.healthy).toBe(true);
        expect(d.send).not.toHaveBeenCalled();
    });

    it('alerts once on first unhealthy check, then suppresses the immediate repeat', async () => {
        const send = vi.fn();
        const unhealthy = { getReconciliationHealth: () => ({ lastSweepSuccessAt: null }), send };
        // First unhealthy pass → one alert.
        await checkVideoPipelineHealth(deps({ ...unhealthy, now }));
        // Second pass moments later (still unhealthy) → suppressed by RE_ALERT_MS.
        await checkVideoPipelineHealth(deps({ ...unhealthy, now: now + 2 * MIN }));
        expect(send).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[0][0].healthy).toBe(false);
    });

    it('sends a recovery notice when it goes healthy again', async () => {
        const send = vi.fn();
        // Trip unhealthy...
        await checkVideoPipelineHealth(deps({ getReconciliationHealth: () => ({ lastSweepSuccessAt: null }), send, now }));
        // ...then recover.
        const r = await checkVideoPipelineHealth(deps({ send, now: now + 3 * MIN }));
        expect(r.healthy).toBe(true);
        const recovery = send.mock.calls.find((c) => c[0].healthy === true);
        expect(recovery).toBeTruthy();
    });
});
