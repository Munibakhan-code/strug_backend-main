import { describe, it, expect, vi } from 'vitest';
import { withTimeout, getReconciliationHealth, classifyUnrecoverable, blobNameFromUrl, videoIdFromRawBlobName } from '../../workers/video-reconciliation.js';

// Contract test for the sweep↔monitor heartbeat. The monitor does
// `const { lastSweepSuccessAt } = getReconciliationHealth()`, so the producer MUST expose that
// exact key. It previously returned `lastSuccessAt`, so the monitor read `undefined` and paged a
// false "sweep never completed a run" outage 45m after every boot. The pure evaluator and the
// monitor's own tests both used the right key, so only a producer-side contract test catches this.
describe('getReconciliationHealth — heartbeat key contract with the monitor', () => {
    it('exposes the heartbeat under `lastSweepSuccessAt` (the key the monitor destructures)', () => {
        const health = getReconciliationHealth();
        expect(Object.prototype.hasOwnProperty.call(health, 'lastSweepSuccessAt')).toBe(true);
        expect(Object.prototype.hasOwnProperty.call(health, 'lastSuccessAt')).toBe(false);
    });

    it('reads null before the first sweep (not undefined — undefined would mask the key bug)', () => {
        const { lastSweepSuccessAt } = getReconciliationHealth();
        expect(lastSweepSuccessAt === null || typeof lastSweepSuccessAt === 'number').toBe(true);
    });
});

// The blob-name derivation the re-queue AND the reaper's exists() probe both depend on. Raw uploads
// live under a `raw/` folder (videos-raw/raw/<file>); the old `.split('/').pop()` dropped that folder,
// so the worker downloaded videos-raw/<file> → BlobNotFound → a valid upload burned MAX_ATTEMPTS and
// was wrongly terminalized 'error' (prod video 1698). The name must stay relative to the container.
describe('blobNameFromUrl — keeps the raw/ folder prefix so the worker can find the source', () => {
    it('preserves the raw/ sub-path (the exact prod 1698 URL that was mis-terminalized)', () => {
        expect(blobNameFromUrl('https://ststrugproduploads.blob.core.windows.net/videos-raw/raw/750-1783301817592-1698.mp4'))
            .toBe('raw/750-1783301817592-1698.mp4');
    });

    it('handles a legacy un-foldered blob (no raw/ prefix) unchanged', () => {
        expect(blobNameFromUrl('https://acct.blob.core.windows.net/videos-raw/1626-1782508117516.mp4'))
            .toBe('1626-1782508117516.mp4');
    });

    it('URL-decodes spaces/special chars in the filename', () => {
        expect(blobNameFromUrl('https://acct.blob.core.windows.net/videos-raw/raw/11-abc-4K%20Ultra%20HD%20Demo.mp4'))
            .toBe('raw/11-abc-4K Ultra HD Demo.mp4');
    });

    it('falls back to the last segment for a non-URL value instead of throwing', () => {
        expect(blobNameFromUrl('videos-raw/raw/clip.mp4')).toBe('clip.mp4');
    });
});

// The reaper decision that stops "1 video wedged, oldest stuck Nm" alerts from paging forever.
// A stuck video the sweep can never advance (no locatable source blob, or attempts exhausted) must
// be terminalized to 'error' so it leaves the backlog; anything still recoverable must be left for
// the normal re-queue path so a transient worker outage never mass-fails good uploads.
describe('classifyUnrecoverable — which stuck videos the sweep terminalizes', () => {
    it('terminalizes a video whose source blob cannot be derived (would skip forever otherwise)', () => {
        const { recoverable, reason } = classifyUnrecoverable({ blobName: '', processingAttempts: 0 });
        expect(recoverable).toBe(false);
        expect(reason).toMatch(/source blob/i);
    });

    it('terminalizes a video that has exhausted its attempt budget', () => {
        const { recoverable, reason } = classifyUnrecoverable({ blobName: 'raw/clip.mp4', processingAttempts: 5, maxAttempts: 5 });
        expect(recoverable).toBe(false);
        expect(reason).toMatch(/exhausted 5/);
    });

    it('leaves a recoverable video (valid blob, attempts remaining) for the re-queue path', () => {
        const { recoverable, reason } = classifyUnrecoverable({ blobName: 'raw/clip.mp4', processingAttempts: 1, maxAttempts: 5 });
        expect(recoverable).toBe(true);
        expect(reason).toBeNull();
    });

    it('does not terminalize a fresh, never-attempted video with a valid blob', () => {
        expect(classifyUnrecoverable({ blobName: 'raw/clip.mp4', processingAttempts: 0 }).recoverable).toBe(true);
    });
});

describe('withTimeout — the sweep hang guard', () => {
    it('passes through a value when the promise settles in time', async () => {
        const r = await withTimeout(Promise.resolve('ok'), 1000, 'fast');
        expect(r).toBe('ok');
    });

    it('propagates a rejection from the wrapped promise', async () => {
        await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'rejects'))
            .rejects.toThrow('boom');
    });

    it('rejects with a timeout error when the promise hangs forever', async () => {
        vi.useFakeTimers();
        const hang = new Promise(() => {}); // never settles — simulates a dropped DB connection
        const raced = withTimeout(hang, 60_000, 'findMany stalled videos');
        const assertion = expect(raced).rejects.toThrow(/findMany stalled videos timed out after 60s/);
        await vi.advanceTimersByTimeAsync(60_000);
        await assertion;
        vi.useRealTimers();
    });

    it('clears its timer once the promise settles (no dangling timeout)', async () => {
        vi.useFakeTimers();
        const clearSpy = vi.spyOn(global, 'clearTimeout');
        await withTimeout(Promise.resolve(1), 60_000, 'fast');
        expect(clearSpy).toHaveBeenCalled();
        clearSpy.mockRestore();
        vi.useRealTimers();
    });
});

// An abandoned upload ('pending_upload') does NOT mean the file never arrived — only that finalize
// never ran. The blob PUT goes browser→storage directly, so a lost finalize leaves the file safely
// uploaded. Prod proved it: 92 raw blobs against 1 video row. The sweep therefore looks the blob up
// by id before failing the row, and this parse is what makes that lookup safe.
describe('videoIdFromRawBlobName — matching an abandoned row to its uploaded blob', () => {
    it('pulls the video id out of a /bulk/presign blob name', () => {
        expect(videoIdFromRawBlobName('raw/4-1783900000000-3.mp4')).toBe(3);
        expect(videoIdFromRawBlobName('raw/115-1783900000000-1698.mov')).toBe(1698);
    });

    it('returns null for a single /presign name, whose trailing number is a TIMESTAMP', () => {
        // `raw/<userId>-<ts>.<ext>` — reading 1783900000000 as a video id would map the row onto a
        // stranger's file. Only the three-part bulk shape may match.
        expect(videoIdFromRawBlobName('raw/4-1783900000000.mp4')).toBeNull();
    });

    it('returns null for names with no id, rather than guessing', () => {
        expect(videoIdFromRawBlobName('raw/whatever.mp4')).toBeNull();
        expect(videoIdFromRawBlobName('')).toBeNull();
        expect(videoIdFromRawBlobName(null)).toBeNull();
    });
});
