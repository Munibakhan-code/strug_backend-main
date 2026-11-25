import { describe, it, expect } from 'vitest';
import {
  capSubscriberPicks,
  dedupeSubscriberPicks,
  filterSubscriberPickRows,
  parseCreatePickBody,
  parsePickIdParam,
  parseSubscriberPicksQuery,
  normalizePickNote,
  ownedCreatorPickOr404,
  MAX_PICK_NOTE_LEN,
} from '../../utils/creator-choice-picks.js';

describe('parseSubscriberPicksQuery', () => {
  it('defaults blank / NaN / non-positive limit to 12 and floors exclude', () => {
    expect(parseSubscriberPicksQuery({})).toEqual({ limit: 12, excludeId: null });
    expect(parseSubscriberPicksQuery({ limit: '', exclude: '12.9' })).toEqual({ limit: 12, excludeId: 12 });
    expect(parseSubscriberPicksQuery({ limit: '0', exclude: '-3' })).toEqual({ limit: 12, excludeId: null });
    expect(parseSubscriberPicksQuery({ limit: '99', exclude: '7' })).toEqual({ limit: 24, excludeId: 7 });
  });
});

describe('parseCreatePickBody', () => {
  it('accepts video and channel picks with optional note', () => {
    expect(parseCreatePickBody({ pick_type: 'video', video_id: 5 })).toEqual({
      ok: true,
      pick_type: 'video',
      video_id: 5,
      target_channel_id: null,
      note: null,
    });
    expect(parseCreatePickBody({ pick_type: 'channel', target_channel_id: 9, note: 'Try this' })).toEqual({
      ok: true,
      pick_type: 'channel',
      video_id: null,
      target_channel_id: 9,
      note: 'Try this',
    });
  });

  it('rejects invalid pick_type and missing ids', () => {
    expect(parseCreatePickBody({ pick_type: 'playlist' }).ok).toBe(false);
    expect(parseCreatePickBody({ pick_type: 'video' }).ok).toBe(false);
    expect(parseCreatePickBody({ pick_type: 'channel' }).ok).toBe(false);
  });
});

describe('normalizePickNote', () => {
  it('trims and caps note length', () => {
    expect(normalizePickNote('  hi  ')).toEqual({ value: 'hi' });
    expect(normalizePickNote('').value).toBeNull();
    expect(normalizePickNote('x'.repeat(MAX_PICK_NOTE_LEN + 1)).error).toMatch(/at most/);
  });
});

describe('parsePickIdParam', () => {
  it('guards NaN and non-positive ids', () => {
    expect(parsePickIdParam('abc').ok).toBe(false);
    expect(parsePickIdParam('0').ok).toBe(false);
    expect(parsePickIdParam('12')).toEqual({ ok: true, pick_id: 12 });
  });
});

describe('dedupeSubscriberPicks', () => {
  it('keeps the first row per video or channel target', () => {
    const rows = [
      { pick_type: 'video', video_id: 1, target_channel_id: null },
      { pick_type: 'video', video_id: 1, target_channel_id: null },
      { pick_type: 'channel', video_id: null, target_channel_id: 3 },
      { pick_type: 'channel', video_id: null, target_channel_id: 3 },
    ];
    expect(dedupeSubscriberPicks(rows)).toHaveLength(2);
  });
});

describe('filterSubscriberPickRows', () => {
  const activeChannel = { is_active: true, user: { social_profiles: { is_banned: false } } };
  const bannedChannel = { is_active: true, user: { social_profiles: { is_banned: true } } };

  it('drops unsafe / inactive / banned / unfinished picks and excluded video', () => {
    const rows = [
      {
        pick_type: 'video',
        video_id: 10,
        channel: activeChannel,
        video: {
          video_id: 10,
          status: 'safe',
          processing_status: 'done',
          channel: activeChannel,
        },
      },
      {
        pick_type: 'video',
        video_id: 11,
        channel: activeChannel,
        video: {
          video_id: 11,
          status: 'pending',
          processing_status: 'done',
          channel: activeChannel,
        },
      },
      {
        pick_type: 'video',
        video_id: 12,
        channel: activeChannel,
        video: {
          video_id: 12,
          status: 'safe',
          processing_status: 'processing',
          channel: activeChannel,
        },
      },
      {
        pick_type: 'channel',
        target_channel_id: 5,
        channel: activeChannel,
        target_channel: bannedChannel,
      },
    ];
    expect(filterSubscriberPickRows(rows, { excludeId: 10 })).toEqual([]);
    expect(filterSubscriberPickRows(rows)).toHaveLength(1);
    expect(filterSubscriberPickRows(rows)[0].video_id).toBe(10);
  });
});

describe('ownedCreatorPickOr404', () => {
  it('maps missing ownership rows to 404', () => {
    expect(ownedCreatorPickOr404(null)).toEqual({
      ok: false,
      status: 404,
      message: 'Pick not found.',
    });
    expect(ownedCreatorPickOr404({ pick_id: 7 })).toEqual({ ok: true, pick_id: 7 });
  });
});

describe('capSubscriberPicks', () => {
  it('returns empty for invalid limits', () => {
    expect(capSubscriberPicks([1, 2, 3], NaN)).toEqual([]);
    expect(capSubscriberPicks([1, 2, 3], 0)).toEqual([]);
  });
});
