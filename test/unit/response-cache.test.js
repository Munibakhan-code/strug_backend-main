import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Redis is absent in prod, which is the case this cache exists for, so the default here is
// "not ready" — the same thing redis-client reports when no Redis is reachable.
vi.mock('../../utils/redis-client.js', () => ({
  default: {
    get: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
    scan: vi.fn(async () => ['0', []]),
    del: vi.fn(async () => 1),
  },
  isRedisReady: vi.fn(() => false),
}));

const { default: redis, isRedisReady } = await import('../../utils/redis-client.js');
const { readCachedJson, writeCachedJson, dropCachedPrefix, clearMemoryCache } = await import('../../utils/response-cache.js');

describe('response cache without Redis', () => {
  beforeEach(() => {
    clearMemoryCache();
    isRedisReady.mockReturnValue(false);
    redis.get.mockClear();
    redis.set.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it('serves a written payload back without touching Redis', async () => {
    await writeCachedJson('video:recommendations:5', [{ video_id: 1 }], 120);

    expect(await readCachedJson('video:recommendations:5')).toEqual([{ video_id: 1 }]);
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('misses on an unknown key', async () => {
    expect(await readCachedJson('video:feed:nothing')).toBeNull();
  });

  // A per-process entry cannot be invalidated on another instance, so it is held for at most 30s
  // however long the Redis TTL would have been — a deleted video must not linger for minutes.
  it('caps the entry lifetime at thirty seconds', async () => {
    vi.useFakeTimers();
    await writeCachedJson('video:feed:long', { items: [] }, 120);

    vi.advanceTimersByTime(29_000);
    expect(await readCachedJson('video:feed:long')).toEqual({ items: [] });

    vi.advanceTimersByTime(2_000);
    expect(await readCachedJson('video:feed:long')).toBeNull();
  });

  it('keeps a shorter TTL as asked', async () => {
    vi.useFakeTimers();
    await writeCachedJson('video:feed:short', { items: [] }, 10);

    vi.advanceTimersByTime(11_000);
    expect(await readCachedJson('video:feed:short')).toBeNull();
  });

  it('drops a whole key family, which is how a deleted video is invalidated', async () => {
    await writeCachedJson('video:recommendations:1', ['a'], 120);
    await writeCachedJson('video:recommendations:2', ['b'], 120);
    await writeCachedJson('video:search:cats', ['c'], 300);

    expect(dropCachedPrefix('video:recommendations:')).toBe(2);
    expect(await readCachedJson('video:recommendations:1')).toBeNull();
    expect(await readCachedJson('video:search:cats')).toEqual(['c']);
  });

  it('stays bounded, evicting the oldest entries rather than growing forever', async () => {
    for (let i = 0; i < 520; i++) {
      await writeCachedJson(`video:feed:${i}`, [i], 120);
    }

    expect(await readCachedJson('video:feed:0')).toBeNull();
    expect(await readCachedJson('video:feed:519')).toEqual([519]);
  });
});

describe('response cache with Redis available', () => {
  beforeEach(() => {
    clearMemoryCache();
    isRedisReady.mockReturnValue(true);
    redis.get.mockClear();
    redis.set.mockClear();
  });

  it('reads and writes through to Redis, unchanged from before', async () => {
    redis.get.mockResolvedValueOnce(JSON.stringify([{ video_id: 7 }]));
    expect(await readCachedJson('video:recommendations:7')).toEqual([{ video_id: 7 }]);

    await writeCachedJson('video:recommendations:7', [{ video_id: 7 }], 120);
    expect(redis.set).toHaveBeenCalledWith('video:recommendations:7', JSON.stringify([{ video_id: 7 }]), 'EX', 120);
  });

  it('treats a corrupt Redis entry as a miss instead of throwing', async () => {
    redis.get.mockResolvedValueOnce('{not json');
    expect(await readCachedJson('video:feed:broken')).toBeNull();
  });

  it('falls back to the bounded memory copy when Redis read fails', async () => {
    await writeCachedJson('video:feed:fallback', { items: [1] }, 120);
    redis.get.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(readCachedJson('video:feed:fallback')).resolves.toEqual({ items: [1] });
  });

  it('never fails the response when Redis write fails', async () => {
    redis.set.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(writeCachedJson('video:feed:write-fallback', { items: [2] }, 120)).resolves.toBeUndefined();
    redis.get.mockRejectedValueOnce(new Error('redis still unavailable'));
    await expect(readCachedJson('video:feed:write-fallback')).resolves.toEqual({ items: [2] });
  });
});
