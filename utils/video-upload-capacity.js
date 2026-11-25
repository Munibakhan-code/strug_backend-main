/**
 * Upload admission control for the Videos vertical.
 *
 * Two gates, for two different failure modes:
 *   1. Interactive-lane depth — a real transcode backlog. Bulk (town hall) is a different queue
 *      on purpose; summing it into this cap 429s Videos uploads while that other lane is busy.
 *   2. Per-user in-flight Redis set — one client cannot open unbounded SAS slots. Finalize `srem`
 *      can fail; members also go stale when a row is deleted or finishes. Callers prune first.
 *
 * Depth is cached briefly and in-flight reads are coalesced so 100k concurrent presigns do not
 * each hit Azure Queue getProperties. The cap itself is not "more users"; raise it when you add
 * interactive worker replicas.
 */

export function videoQueueBackpressureLimit(env = process.env) {
  const n = Number(env.VIDEO_QUEUE_BACKPRESSURE_DEPTH);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 500;
}

export function maxConcurrentUploadsPerUser(env = process.env) {
  const n = Number(env.VIDEO_MAX_CONCURRENT_UPLOADS_PER_USER);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
}

/** 0 disables the cache. Unset / blank / invalid → 2000ms. */
export function videoQueueDepthCacheMs(env = process.env) {
  const raw = env.VIDEO_QUEUE_DEPTH_CACHE_MS;
  if (raw === undefined || raw === null || raw === '') return 2000;
  const n = Number(raw);
  if (n === 0) return 0;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2000;
}

export function activeUploadsKey(userId) {
  return `uploads:active:${userId}`;
}

export function asNonNegativeInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export function createVideoQueueDepthCache() {
  return { expiresAt: 0, snapshot: undefined, inflight: null };
}

const defaultDepthCache = createVideoQueueDepthCache();

export function resetVideoQueueDepthCache(cache = defaultDepthCache) {
  cache.expiresAt = 0;
  cache.snapshot = undefined;
  cache.inflight = null;
}

function clockMs(now) {
  if (typeof now === 'function') {
    const t = Number(now());
    if (Number.isFinite(t)) return t;
  }
  return Date.now();
}

function stillInFlight(row) {
  if (!row) return false;
  if (row.processing_status === 'done' || row.processing_status === 'error') return false;
  return true;
}

/**
 * Drop Redis members that are gone, finished, or failed. Open presigns (`pending_upload`) and
 * in-progress direct uploads stay until finalize `srem`, processing completes, or the 24h TTL.
 * Returns the count still in the set.
 */
export async function pruneActiveUploadSet({ redis, prisma, userId, logger }) {
  const key = activeUploadsKey(userId);
  const members = await redis.smembers(key);
  if (!Array.isArray(members) || members.length === 0) return 0;

  const numeric = [];
  const junk = [];
  for (const raw of members) {
    const id = Number(raw);
    if (!Number.isFinite(id) || id <= 0) {
      junk.push(String(raw));
      continue;
    }
    numeric.push(id);
  }
  if (junk.length > 0) {
    await Promise.all(junk.map((raw) => redis.srem(key, raw)));
  }
  if (numeric.length === 0) return asNonNegativeInt(await redis.scard(key));

  const rows = await prisma.video.findMany({
    where: { video_id: { in: numeric } },
    select: { video_id: true, processing_status: true },
  });
  const live = new Set(
    rows.filter(stillInFlight).map((v) => Number(v.video_id)).filter((id) => Number.isFinite(id) && id > 0)
  );
  const stale = numeric.filter((id) => !live.has(id));
  if (stale.length > 0) {
    await Promise.all(stale.map(async (id) => {
      await redis.srem(key, String(id));
      logger?.info?.({ message: 'Dropped stale active-upload id', user_id: userId, video_id: id });
    }));
  }
  return asNonNegativeInt(await redis.scard(key));
}

export async function countActiveUploads({ redis, prisma, userId, logger }) {
  try {
    return asNonNegativeInt(await pruneActiveUploadSet({ redis, prisma, userId, logger }));
  } catch (err) {
    logger?.warn?.({
      message: 'Could not prune active upload set; counting Redis as-is',
      user_id: userId,
      err: err?.message,
    });
    return asNonNegativeInt(await redis.scard(activeUploadsKey(userId)));
  }
}

async function loadQueueDepths({ getQueueDepths, logger, cache, nowMs, ttl }) {
  if (ttl > 0 && nowMs < cache.expiresAt && cache.snapshot !== undefined) {
    return cache.snapshot;
  }
  if (cache.inflight) return cache.inflight;

  cache.inflight = (async () => {
    try {
      const depths = await getQueueDepths();
      const snapshot = { ok: true, depths };
      if (ttl > 0) {
        cache.snapshot = snapshot;
        cache.expiresAt = nowMs + ttl;
      }
      return snapshot;
    } catch (err) {
      logger?.warn?.({
        message: 'Could not read video queue depths; not blocking uploads',
        err: err?.message,
      });
      const snapshot = { ok: false };
      if (ttl > 0) {
        cache.snapshot = snapshot;
        cache.expiresAt = nowMs + ttl;
      }
      return snapshot;
    } finally {
      cache.inflight = null;
    }
  })();

  return cache.inflight;
}

/**
 * Reject new Videos uploads only when the INTERACTIVE transcode lane is at the configured depth.
 * Unknown depths do not block: a storage blip must not freeze every uploader.
 */
export async function assertVideoPipelineAcceptingUploads({
  getQueueDepths,
  logger,
  env,
  now,
  cache = defaultDepthCache,
} = {}) {
  if (typeof getQueueDepths !== 'function') {
    throw new Error('assertVideoPipelineAcceptingUploads requires getQueueDepths');
  }
  const resolvedEnv = env ?? process.env;
  const limit = videoQueueBackpressureLimit(resolvedEnv);
  const ttl = videoQueueDepthCacheMs(resolvedEnv);
  const snapshot = await loadQueueDepths({
    getQueueDepths,
    logger,
    cache,
    nowMs: clockMs(now),
    ttl,
  });
  if (!snapshot.ok) return;

  const depths = snapshot.depths;
  if (!depths || depths.interactive == null) return;

  const interactive = Number(depths.interactive);
  if (!Number.isFinite(interactive)) return;

  if (interactive >= limit) {
    logger?.warn?.({
      message: 'Video upload backpressure',
      interactive,
      bulk: depths.bulk ?? null,
      limit,
      code: 'VIDEO_PIPELINE_BUSY',
    });
    const err = new Error(
      `Video processing is at capacity (queue depth ${interactive}). Please try again in a few minutes.`
    );
    err.status = 429;
    err.code = 'VIDEO_PIPELINE_BUSY';
    throw err;
  }
}
