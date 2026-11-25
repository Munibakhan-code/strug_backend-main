import redis, { isRedisReady } from './redis-client.js';

const memBuckets = new Map();
const MAX_MEM_KEYS = 5000;
let memFallbackWarnedAt = 0;

function memCheck(key, max, windowSecs) {
  const now = Date.now();
  const bucket = memBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    memBuckets.set(key, { count: 1, resetAt: now + windowSecs * 1000 });
    return 1 > max;
  }
  bucket.count += 1;
  return bucket.count > max;
}

function memPeek(key, max) {
  const now = Date.now();
  const bucket = memBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) return false;
  return bucket.count > max;
}

function memSweep() {
  const now = Date.now();
  for (const [k, b] of memBuckets) {
    if (b.resetAt <= now) {
      memBuckets.delete(k);
    }
  }
  // Hard cap under Redis outage so unique keys cannot grow unbounded.
  if (memBuckets.size > MAX_MEM_KEYS) {
    const excess = memBuckets.size - MAX_MEM_KEYS;
    const keys = memBuckets.keys();
    for (let i = 0; i < excess; i++) {
      const next = keys.next();
      if (next.done) break;
      memBuckets.delete(next.value);
    }
  }
}

function warnMemFallback(kind) {
  const now = Date.now();
  if (now - memFallbackWarnedAt < 60_000) return;
  memFallbackWarnedAt = now;
  console.warn(
    `[rate-limit] Redis unavailable — ${kind} using in-process memory buckets (not shared across replicas). ` +
      `Set REDIS_URL for shared limits, or AUTH_RATE_LIMIT_REQUIRE_REDIS=1 to fail closed.`,
  );
}

/** True when auth/OTP must refuse traffic without a shared Redis store.
 * Explicit AUTH_RATE_LIMIT_REQUIRE_REDIS=1|true forces fail-closed.
 * Explicit 0|false keeps memory fallback even with REDIS_URL.
 * Default (#1288): fail-closed when REDIS_URL is set on real production (APP_ENV !== staging),
 * so multi-replica auth limits cannot silently degrade to per-process buckets. */
export function authRateLimitRequiresRedis() {
  const flag = String(process.env.AUTH_RATE_LIMIT_REQUIRE_REDIS || '').trim().toLowerCase();
  if (flag === '1' || flag === 'true') return true;
  if (flag === '0' || flag === 'false') return false;
  const hasRedis = Boolean(String(process.env.REDIS_URL || '').trim());
  const isStaging = process.env.APP_ENV === 'staging';
  const isProdRuntime = process.env.NODE_ENV === 'production';
  return hasRedis && isProdRuntime && !isStaging;
}

/** Read-only: is the key already over the limit? Does not increment. */
export async function isRateLimited(key, max, opts = {}) {
  const failClosed = opts.failClosed === true || (opts.auth === true && authRateLimitRequiresRedis());
  if (opts.auth && !isRedisReady()) {
    if (failClosed) return true;
    warnMemFallback('auth peek');
    return memPeek(key, max);
  }
  try {
    if (!isRedisReady()) {
      return memPeek(key, max);
    }
    const raw = await redis.get(key);
    // When Redis is down / flaps, get may look like a miss. Always also consult the
    // in-memory bucket so limits recorded via memCheck still enforce.
    if (raw != null) {
      const count = Number(raw);
      if (Number.isFinite(count) && count > max) return true;
    }
  } catch {
    if (failClosed) return true;
    /* fall through to memory */
  }
  return memPeek(key, max);
}

/**
 * Increment and return whether the key is over the limit.
 * @param {object} [opts]
 * @param {boolean} [opts.auth] — auth/OTP path: prefer Redis; optional fail-closed via env
 * @param {boolean} [opts.failClosed] — if store unavailable, treat as limited
 */
export async function checkRateLimit(key, max, windowSecs, opts = {}) {
  const failClosed = opts.failClosed === true || (opts.auth === true && authRateLimitRequiresRedis());

  if (isRedisReady()) {
    try {
      await redis.set(key, 0, 'EX', windowSecs, 'NX');
      const count = await redis.incr(key);
      if (typeof count === 'number' && Number.isFinite(count)) {
        return count > max;
      }
    } catch {
      // Redis ready but command failed: honor failClosed (do not silently use memory).
      if (failClosed) return true;
      warnMemFallback('increment after Redis error');
    }
  } else if (opts.auth) {
    if (failClosed) return true;
    warnMemFallback('auth increment');
  }

  if (failClosed && !isRedisReady()) return true;

  if (memBuckets.size > MAX_MEM_KEYS) {
    memSweep();
  }
  return memCheck(key, max, windowSecs);
}

/** Auth/OTP convenience: shared Redis when available; fail-closed only when env requires it. */
export async function checkAuthRateLimit(key, max, windowSecs) {
  return checkRateLimit(key, max, windowSecs, { auth: true });
}

export async function isAuthRateLimited(key, max) {
  return isRateLimited(key, max, { auth: true });
}

export async function clearRateLimit(key) {
  try {
    await redis.del(key);
  } catch {
    /* ignore */
  }
  memBuckets.delete(key);
}
