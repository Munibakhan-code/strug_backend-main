import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  videoQueueBackpressureLimit,
  maxConcurrentUploadsPerUser,
  videoQueueDepthCacheMs,
  assertVideoPipelineAcceptingUploads,
  pruneActiveUploadSet,
  countActiveUploads,
  activeUploadsKey,
  asNonNegativeInt,
  createVideoQueueDepthCache,
  resetVideoQueueDepthCache,
} from '../../utils/video-upload-capacity.js';

beforeEach(() => {
  resetVideoQueueDepthCache();
});

describe('videoQueueBackpressureLimit', () => {
  it('defaults to 500 when unset, zero, or NaN', () => {
    expect(videoQueueBackpressureLimit({})).toBe(500);
    expect(videoQueueBackpressureLimit({ VIDEO_QUEUE_BACKPRESSURE_DEPTH: '' })).toBe(500);
    expect(videoQueueBackpressureLimit({ VIDEO_QUEUE_BACKPRESSURE_DEPTH: 'nope' })).toBe(500);
    expect(videoQueueBackpressureLimit({ VIDEO_QUEUE_BACKPRESSURE_DEPTH: '0' })).toBe(500);
  });

  it('uses a positive integer env', () => {
    expect(videoQueueBackpressureLimit({ VIDEO_QUEUE_BACKPRESSURE_DEPTH: '80' })).toBe(80);
  });
});

describe('maxConcurrentUploadsPerUser', () => {
  it('defaults to 5 when unset or invalid', () => {
    expect(maxConcurrentUploadsPerUser({})).toBe(5);
    expect(maxConcurrentUploadsPerUser({ VIDEO_MAX_CONCURRENT_UPLOADS_PER_USER: 'x' })).toBe(5);
    expect(maxConcurrentUploadsPerUser({ VIDEO_MAX_CONCURRENT_UPLOADS_PER_USER: '0' })).toBe(5);
  });

  it('uses a positive integer env', () => {
    expect(maxConcurrentUploadsPerUser({ VIDEO_MAX_CONCURRENT_UPLOADS_PER_USER: '3' })).toBe(3);
  });
});

describe('videoQueueDepthCacheMs', () => {
  it('defaults to 2000 when unset or invalid, and 0 disables', () => {
    expect(videoQueueDepthCacheMs({})).toBe(2000);
    expect(videoQueueDepthCacheMs({ VIDEO_QUEUE_DEPTH_CACHE_MS: '' })).toBe(2000);
    expect(videoQueueDepthCacheMs({ VIDEO_QUEUE_DEPTH_CACHE_MS: 'nope' })).toBe(2000);
    expect(videoQueueDepthCacheMs({ VIDEO_QUEUE_DEPTH_CACHE_MS: '0' })).toBe(0);
    expect(videoQueueDepthCacheMs({ VIDEO_QUEUE_DEPTH_CACHE_MS: '1500' })).toBe(1500);
  });
});

describe('asNonNegativeInt', () => {
  it('floors finite values and treats invalid as 0', () => {
    expect(asNonNegativeInt('2')).toBe(2);
    expect(asNonNegativeInt(2.9)).toBe(2);
    expect(asNonNegativeInt('x')).toBe(0);
    expect(asNonNegativeInt(-1)).toBe(0);
  });
});

describe('assertVideoPipelineAcceptingUploads', () => {
  const env = { VIDEO_QUEUE_BACKPRESSURE_DEPTH: '500', VIDEO_QUEUE_DEPTH_CACHE_MS: '0' };

  it('does not count the bulk lane toward the user-upload cap', async () => {
    await expect(assertVideoPipelineAcceptingUploads({
      getQueueDepths: async () => ({ interactive: 499, bulk: 999, deadletter: 0 }),
      env,
    })).resolves.toBeUndefined();
  });

  it('rejects when the interactive lane itself is at the limit', async () => {
    const logger = { warn: vi.fn() };
    await expect(assertVideoPipelineAcceptingUploads({
      getQueueDepths: async () => ({ interactive: 500, bulk: 0 }),
      logger,
      env,
    })).rejects.toMatchObject({ status: 429, code: 'VIDEO_PIPELINE_BUSY' });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('does not block when interactive depth is unknown', async () => {
    await expect(assertVideoPipelineAcceptingUploads({
      getQueueDepths: async () => ({ interactive: null, bulk: 999 }),
      env,
    })).resolves.toBeUndefined();
  });

  it('does not block when queue depth cannot be read', async () => {
    const logger = { warn: vi.fn() };
    await expect(assertVideoPipelineAcceptingUploads({
      getQueueDepths: async () => { throw new Error('storage down'); },
      logger,
      env,
    })).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('does not block when interactive depth is not a finite number', async () => {
    await expect(assertVideoPipelineAcceptingUploads({
      getQueueDepths: async () => ({ interactive: 'nope', bulk: 999 }),
      env,
    })).resolves.toBeUndefined();
  });

  it('reuses a fresh depth read within the cache window', async () => {
    const getQueueDepths = vi.fn(async () => ({ interactive: 10, bulk: 0 }));
    const cache = createVideoQueueDepthCache();
    const cachedEnv = { VIDEO_QUEUE_BACKPRESSURE_DEPTH: '500', VIDEO_QUEUE_DEPTH_CACHE_MS: '2000' };
    let t = 1000;
    await assertVideoPipelineAcceptingUploads({ getQueueDepths, env: cachedEnv, cache, now: () => t });
    t = 2500;
    await assertVideoPipelineAcceptingUploads({ getQueueDepths, env: cachedEnv, cache, now: () => t });
    expect(getQueueDepths).toHaveBeenCalledTimes(1);
  });

  it('refetches after the cache window', async () => {
    const getQueueDepths = vi.fn(async () => ({ interactive: 10, bulk: 0 }));
    const cache = createVideoQueueDepthCache();
    const cachedEnv = { VIDEO_QUEUE_BACKPRESSURE_DEPTH: '500', VIDEO_QUEUE_DEPTH_CACHE_MS: '2000' };
    let t = 1000;
    await assertVideoPipelineAcceptingUploads({ getQueueDepths, env: cachedEnv, cache, now: () => t });
    t = 4000;
    await assertVideoPipelineAcceptingUploads({ getQueueDepths, env: cachedEnv, cache, now: () => t });
    expect(getQueueDepths).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent depth reads', async () => {
    let release;
    const getQueueDepths = vi.fn(() => new Promise((resolve) => {
      release = () => resolve({ interactive: 3, bulk: 0 });
    }));
    const cache = createVideoQueueDepthCache();
    const p1 = assertVideoPipelineAcceptingUploads({ getQueueDepths, env, cache });
    const p2 = assertVideoPipelineAcceptingUploads({ getQueueDepths, env, cache });
    release();
    await Promise.all([p1, p2]);
    expect(getQueueDepths).toHaveBeenCalledTimes(1);
  });
});

describe('pruneActiveUploadSet', () => {
  let redis;
  const set = new Set();

  beforeEach(() => {
    set.clear();
    redis = {
      smembers: vi.fn(async () => [...set]),
      srem: vi.fn(async (_k, id) => { set.delete(String(id)); }),
      scard: vi.fn(async () => set.size),
    };
  });

  it('drops ids that finished, failed, or no longer exist', async () => {
    set.add('10');
    set.add('11');
    set.add('12');
    set.add('13');
    set.add('99');
    set.add('bad');
    const prisma = {
      video: {
        findMany: vi.fn(async () => [
          { video_id: 10, processing_status: 'pending' },
          { video_id: 11, processing_status: 'pending' },
          { video_id: 12, processing_status: 'error' },
          { video_id: 13, processing_status: 'done' },
        ]),
      },
    };
    const n = await pruneActiveUploadSet({ redis, prisma, userId: 7, logger: { info: vi.fn() } });
    expect(n).toBe(2);
    expect([...set].sort()).toEqual(['10', '11']);
    expect(activeUploadsKey(7)).toBe('uploads:active:7');
  });

  it('keeps pending_upload and processing ids', async () => {
    set.add('1');
    set.add('2');
    const prisma = {
      video: {
        findMany: vi.fn(async () => [
          { video_id: 1, processing_status: 'pending_upload' },
          { video_id: 2, processing_status: 'processing' },
        ]),
      },
    };
    const n = await pruneActiveUploadSet({ redis, prisma, userId: 7 });
    expect(n).toBe(2);
    expect([...set].sort()).toEqual(['1', '2']);
  });
});

describe('countActiveUploads', () => {
  it('still counts Redis when prune fails, and logs it', async () => {
    const logger = { warn: vi.fn() };
    const redis = {
      smembers: vi.fn(async () => { throw new Error('redis timeout'); }),
      scard: vi.fn(async () => '2'),
    };
    await expect(countActiveUploads({ redis, prisma: {}, userId: 1, logger })).resolves.toBe(2);
    expect(logger.warn).toHaveBeenCalled();
  });
});
