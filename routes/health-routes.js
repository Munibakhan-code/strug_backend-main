// Liveness and readiness probes.
//
// Supersedes `GET /social-system/health` (routes/social-system-routes.js), which conflated
// liveness with readiness: it ran `SELECT 1` and answered 500 when the database was
// unreachable. Wired to a container LIVENESS probe that is the wrong behaviour — a database
// blip would get an otherwise healthy replica killed and restarted, turning a brief dependency
// outage into a restart loop. It also had no timeout, so a hung query hung the probe, and no
// visibility into Redis.
//
// That endpoint is left in place (it is referenced in the README and may be wired into external
// monitors); prefer these for anything the platform acts on.
//
// Three endpoints, deliberately distinct:
//   GET /health   — liveness. Process is up and the event loop is responsive. No I/O, so it
//                   never fails because a *dependency* is down; killing a replica for that
//                   would be wrong.
//   GET /health/ready — readiness. Actually touches Postgres and Redis. 503 when a hard
//                   dependency is unavailable, so the platform stops routing to this replica
//                   until it recovers.
//   GET /health/startup — startup probe. Same checks as readiness but intended for the
//                   initial boot gate, where a slow first Prisma connect is expected.
//
// All three are unauthenticated by design (a probe cannot hold a token) and deliberately leak
// nothing: no versions, no connection strings, no error details — just a status and per-check
// booleans. Detail goes to the logs, never the response body.
import express from 'express';
import prisma from '../utils/prisma-client.js';
import redis from '../utils/redis-client.js';
import logger from '../utils/logger.js';

const router = express.Router();

const BOOTED_AT = Date.now();

// A dependency check must never hang a probe: the orchestrator's own timeout would fire and the
// replica would be recycled on a slow query rather than a broken one.
const CHECK_TIMEOUT_MS = Number(process.env.HEALTH_CHECK_TIMEOUT_MS || 2000);

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${label} check timed out after ${ms}ms`)), ms).unref?.(),
    ),
  ]);
}

async function checkDatabase() {
  await withTimeout(prisma.$queryRaw`SELECT 1`, CHECK_TIMEOUT_MS, 'database');
  return true;
}

async function checkRedis() {
  // Redis is a soft dependency here: the rate limiter and caches fall back to in-memory when it
  // is down (see middleware/rate-limit.js), so a Redis outage degrades rather than breaks. It is
  // reported, but it does not by itself make the replica unready.
  if (!redis || redis.status !== 'ready') return false;
  await withTimeout(redis.ping(), CHECK_TIMEOUT_MS, 'redis');
  return true;
}

async function collectChecks() {
  const [dbResult, redisResult] = await Promise.allSettled([checkDatabase(), checkRedis()]);
  return {
    database: dbResult.status === 'fulfilled' && dbResult.value === true,
    redis: redisResult.status === 'fulfilled' && redisResult.value === true,
    // Surfaced for the log line below, never for the response body.
    _errors: {
      database: dbResult.status === 'rejected' ? dbResult.reason?.message : undefined,
      redis: redisResult.status === 'rejected' ? redisResult.reason?.message : undefined,
    },
  };
}

/** Liveness — no dependency I/O. 200 for as long as this process can serve a request. */
router.get('/', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime_s: Math.floor((Date.now() - BOOTED_AT) / 1000),
  });
});

async function readiness(req, res) {
  const { database, redis: redisOk, _errors } = await collectChecks();

  // Postgres is the only hard dependency — without it essentially every route 500s.
  const ready = database;

  if (!ready) {
    logger.error({
      message: 'Readiness probe failed',
      path: req.originalUrl,
      correlation_id: req.correlationId,
      checks: { database, redis: redisOk },
      errors: _errors,
    });
  }

  res.status(ready ? 200 : 503).json({
    status: ready ? 'ok' : 'unavailable',
    checks: { database, redis: redisOk },
    uptime_s: Math.floor((Date.now() - BOOTED_AT) / 1000),
  });
}

/** Readiness — gates traffic. 503 while Postgres is unreachable. */
router.get('/ready', readiness);

/** Startup — same signal, separate path so probe budgets can differ. */
router.get('/startup', readiness);

export default router;
