// Distributed scheduling for a horizontally-scaled API.
//
// Every background job in this service is started in-process from index.js, and none of them
// coordinated with anything. With more than one replica, all of them fire the same tick at the
// same second: duplicate ride dispatch, duplicate work dispatch, duplicate saved-search emails,
// duplicate payout sweeps. That is why deploy.yml pinned `--min-replicas 1 --max-replicas 1`,
// which in turn meant no redundancy, no horizontal scale, and a single point of failure.
//
// This module makes a tick single-flight across replicas using a Redis lock, so replicas can be
// raised safely. Two knobs:
//
//   CRON_ENABLED=false      This replica runs no background jobs at all. Set on API replicas
//                           once jobs move to a dedicated worker container — the clean end
//                           state, where the API scales purely on request load.
//   CRON_REQUIRE_LOCK=true  If Redis is unavailable, SKIP the tick instead of running it.
//                           Mandatory once max-replicas > 1: without Redis there is nothing
//                           preventing every replica from running the same job.
//
// Default behaviour with Redis down and CRON_REQUIRE_LOCK unset is to run the job, which is
// exactly what a single replica does today — so adopting this module changes nothing until
// replicas are actually raised.
import crypto from 'crypto';
import cron from 'node-cron';
import redis from './redis-client.js';
import logger from './logger.js';
import { captureError } from './observability.js';

/** Identifies this process in lock values, so a replica only releases a lock it still owns. */
const OWNER_ID = `${process.env.HOSTNAME || 'local'}:${process.pid}:${crypto.randomUUID()}`;

const KEY_PREFIX = 'cron:lock:';

/** Default lease. Long enough to cover a normal tick, short enough to recover from a crash. */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** How often a held lock is extended while the job is still running. */
const HEARTBEAT_DIVISOR = 3;

export function cronEnabled() {
  return process.env.CRON_ENABLED !== 'false';
}

function requireLock() {
  return process.env.CRON_REQUIRE_LOCK === 'true';
}

function redisReady() {
  return !!redis && redis.status === 'ready';
}

// Release only if this process still holds the lock. Without the compare, a replica whose job
// overran its lease would delete a lock another replica had legitimately acquired.
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

const EXTEND_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end`;

async function acquire(key, ttlMs) {
  const result = await redis.set(key, OWNER_ID, 'PX', ttlMs, 'NX');
  return result === 'OK';
}

async function release(key) {
  try {
    await redis.eval(RELEASE_SCRIPT, 1, key, OWNER_ID);
  } catch (err) {
    // The lease expires on its own, so a failed release costs at most one skipped tick.
    logger.warn({ message: `[cron-lock] release failed for ${key}: ${err.message}` });
  }
}

/**
 * Run `fn` at most once across all replicas for this tick.
 *
 * @param {string} jobId  Stable identifier — the Redis key. Must not change between deploys.
 * @param {() => unknown | Promise<unknown>} fn
 * @param {{ ttlMs?: number }} [options]
 * @returns {Promise<boolean>} true if this replica ran the job, false if it skipped.
 */
export async function withCronLock(jobId, fn, options = {}) {
  if (!cronEnabled()) return false;

  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const key = `${KEY_PREFIX}${jobId}`;

  if (!redisReady()) {
    if (requireLock()) {
      logger.warn({
        message: `[cron-lock] ${jobId} SKIPPED — Redis unavailable and CRON_REQUIRE_LOCK=true`,
        job_id: jobId,
      });
      return false;
    }
    // Single-replica fallback: behaves exactly as this service did before locking existed.
    await runGuarded(jobId, fn);
    return true;
  }

  let acquired = false;
  try {
    acquired = await acquire(key, ttlMs);
  } catch (err) {
    logger.warn({ message: `[cron-lock] ${jobId} acquire failed: ${err.message}`, job_id: jobId });
    if (requireLock()) return false;
    await runGuarded(jobId, fn);
    return true;
  }

  if (!acquired) return false; // another replica owns this tick — the normal, quiet path

  // Keep the lease alive for as long as the job actually runs, so a slow daily sweep is not
  // picked up a second time by another replica halfway through.
  const heartbeat = setInterval(() => {
    redis.eval(EXTEND_SCRIPT, 1, key, OWNER_ID, String(ttlMs)).catch(() => {});
  }, Math.max(1000, Math.floor(ttlMs / HEARTBEAT_DIVISOR)));
  heartbeat.unref?.();

  try {
    await runGuarded(jobId, fn);
    return true;
  } finally {
    clearInterval(heartbeat);
    await release(key);
  }
}

/**
 * Run a job body without letting a throw escape into the scheduler. node-cron and setInterval
 * both swallow a rejected promise silently, which is how a permanently-broken job can go
 * unnoticed for months.
 */
async function runGuarded(jobId, fn) {
  try {
    await fn();
  } catch (err) {
    logger.error({ message: `[cron] ${jobId} failed: ${err?.message}`, job_id: jobId, stack: err?.stack });
    captureError(err, { jobId, kind: 'cron' });
  }
}

/**
 * Drop-in replacement for `cron.schedule(expr, handler)` that is safe on multiple replicas.
 * Argument order matches node-cron after the id, so call sites change only in the head.
 *
 * @param {string} jobId
 * @param {string} expression  Standard cron expression.
 * @param {() => unknown | Promise<unknown>} handler
 * @param {{ ttlMs?: number, cronOptions?: object }} [options]
 */
export function scheduleCron(jobId, expression, handler, options = {}) {
  if (!cronEnabled()) {
    logger.info({ message: `[cron] ${jobId} not scheduled — CRON_ENABLED=false`, job_id: jobId });
    return null;
  }
  return cron.schedule(
    expression,
    () => { withCronLock(jobId, handler, options); },
    options.cronOptions,
  );
}

/**
 * Drop-in replacement for `setInterval(handler, ms)` that is safe on multiple replicas.
 * Argument order matches setInterval after the id, so call sites change only in the head.
 *
 * @param {string} jobId
 * @param {() => unknown | Promise<unknown>} handler
 * @param {number} ms
 * @param {{ ttlMs?: number }} [options]
 */
export function scheduleInterval(jobId, handler, ms, options = {}) {
  if (!cronEnabled()) {
    logger.info({ message: `[cron] ${jobId} not scheduled — CRON_ENABLED=false`, job_id: jobId });
    return null;
  }
  // A lease shorter than the interval would let the next tick start while this one still runs.
  const ttlMs = options.ttlMs ?? Math.max(DEFAULT_TTL_MS, ms * 2);
  const timer = setInterval(() => { withCronLock(jobId, handler, { ...options, ttlMs }); }, ms);
  timer.unref?.();
  return timer;
}

/** Exposed for tests. */
export const __testing = { OWNER_ID, KEY_PREFIX, DEFAULT_TTL_MS };
