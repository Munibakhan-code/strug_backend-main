import { describe, it, expect } from 'vitest';
import {
  isYoutubeImportBusy,
  isYoutubeImportStale,
  youtubeImportStaleMs,
  YOUTUBE_IMPORT_BUSY,
} from '../../utils/youtube-import-job.js';

describe('youtube import job busy / stale', () => {
  it('treats queued listing importing as busy', () => {
    expect(YOUTUBE_IMPORT_BUSY).toEqual(['queued', 'listing', 'importing']);
    expect(isYoutubeImportBusy('importing')).toBe(true);
    expect(isYoutubeImportBusy('done')).toBe(false);
    expect(isYoutubeImportBusy('error')).toBe(false);
    expect(isYoutubeImportBusy(null)).toBe(false);
  });

  it('stale when busy and updated_at older than threshold', () => {
    const now = new Date('2026-09-08T12:00:00Z');
    const fresh = {
      status: 'importing',
      updated_at: new Date('2026-09-08T11:50:00Z'),
    };
    const stale = {
      status: 'importing',
      updated_at: new Date('2026-09-08T11:00:00Z'),
    };
    expect(isYoutubeImportStale(fresh, { now, staleMs: 30 * 60 * 1000 })).toBe(false);
    expect(isYoutubeImportStale(stale, { now, staleMs: 30 * 60 * 1000 })).toBe(true);
  });

  it('done/error jobs are never stale', () => {
    const now = new Date('2026-09-08T12:00:00Z');
    expect(
      isYoutubeImportStale(
        { status: 'done', updated_at: new Date('2020-01-01') },
        { now, staleMs: 1 },
      ),
    ).toBe(false);
  });

  it('missing updated_at on a busy job counts as stale', () => {
    expect(isYoutubeImportStale({ status: 'queued' }, { now: new Date() })).toBe(true);
  });

  it('youtubeImportStaleMs defaults to 30 minutes', () => {
    const prev = process.env.YOUTUBE_IMPORT_STALE_MS;
    delete process.env.YOUTUBE_IMPORT_STALE_MS;
    expect(youtubeImportStaleMs()).toBe(30 * 60 * 1000);
    process.env.YOUTUBE_IMPORT_STALE_MS = '60000';
    expect(youtubeImportStaleMs()).toBe(60000);
    if (prev === undefined) delete process.env.YOUTUBE_IMPORT_STALE_MS;
    else process.env.YOUTUBE_IMPORT_STALE_MS = prev;
  });
});
