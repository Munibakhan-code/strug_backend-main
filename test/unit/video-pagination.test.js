import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, pageResult, parsePageLimit } from '../../utils/video-pagination.js';

describe('video pagination helpers', () => {
  it('bounds requested page sizes', () => {
    expect(parsePageLimit(undefined)).toBe(20);
    expect(parsePageLimit('0')).toBe(20);
    expect(parsePageLimit('8')).toBe(8);
    expect(parsePageLimit('500')).toBe(50);
  });

  it('round-trips opaque cursors and rejects malformed input', () => {
    const value = { watched_at: '2026-09-07T00:00:00.000Z', video_id: 42 };
    expect(decodeCursor(encodeCursor(value))).toEqual(value);
    expect(decodeCursor('not-a-cursor')).toBeNull();
  });

  it('uses one look-ahead row to report another page', () => {
    const result = pageResult([{ id: 3 }, { id: 2 }, { id: 1 }], 2, (row) => row);
    expect(result.data).toEqual([{ id: 3 }, { id: 2 }]);
    expect(result.has_more).toBe(true);
    expect(decodeCursor(result.next_cursor)).toEqual({ id: 2 });
  });
});
