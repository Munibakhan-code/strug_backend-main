// Generic fixed-window rate limiter keyed by authenticated user (if present) else client IP.
// Uses Redis when it is ready (shared across replicas); otherwise falls back to a per-replica
// in-memory window — still a meaningful bound on abuse. Fails OPEN on limiter errors so a
// limiter outage never blocks legitimate traffic.
import redis from '../utils/redis-client.js';

export function rateLimit({ windowSec = 60, max = 30, keyPrefix = 'rl' } = {}) {
  const mem = new Map(); // key -> { count, resetAt }

  return async (req, res, next) => {
    const who = req.user?.user_id
      ? `u:${req.user.user_id}`
      : `ip:${req.ip || req.headers['x-forwarded-for'] || 'unknown'}`;
    const key = `${keyPrefix}:${who}`;

    // --- Redis path (cross-replica) ---
    try {
      if (redis && redis.status === 'ready') {
        const n = await redis.incr(key);
        if (n === 1) await redis.expire(key, windowSec);
        if (n > max) {
          const ttl = await redis.ttl(key);
          res.set('Retry-After', String(ttl > 0 ? ttl : windowSec));
          return res.status(429).json({ successful: false, message: 'Too many requests. Please slow down.' });
        }
        return next();
      }
    } catch (err) {
      console.warn(`[rate-limit] limiter error (fail-open): ${err.message}`);
      return next();
    }

    // --- In-memory fallback (per-replica) ---
    const now = Date.now();
    const rec = mem.get(key);
    if (!rec || rec.resetAt <= now) {
      mem.set(key, { count: 1, resetAt: now + windowSec * 1000 });
      if (mem.size > 10000) { // opportunistic cleanup of expired keys
        for (const [k, v] of mem) if (v.resetAt <= now) mem.delete(k);
      }
      return next();
    }
    rec.count += 1;
    if (rec.count > max) {
      const retry = Math.ceil((rec.resetAt - now) / 1000);
      res.set('Retry-After', String(retry));
      return res.status(429).json({ successful: false, message: 'Too many requests. Please slow down.' });
    }
    return next();
  };
}
