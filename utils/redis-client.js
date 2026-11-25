import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

// Redis is an OPTIONAL accelerator here (live-viewer presence sets, ads pacing/fraud counters,
// the ad-context cache, rate-limiter). The platform is fully functional without it — those
// features just lose their cache/throttle layer. Prod has never had a managed Redis provisioned
// (REDIS_URL unset → the default localhost target refuses), so for months every command on the
// dead connection rejected with "Connection is closed." and each caller logged it. With a
// once-a-minute consistency heartbeat (index.js) driving it, that buried the real logs — it's
// what hid the reconciliation-sweep outage on 2026-06-21 until the email alert fired.
//
// Fix: gate every command on a `ready` flag. When Redis isn't connected we return a safe default
// (so callers degrade exactly as if it were a cache miss) instead of issuing a command that
// throws, and we log the unavailability ONCE rather than on every call. When a real Redis IS
// reachable (REDIS_URL set, or a local dev Redis), behaviour is unchanged — commands pass through.

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

const client = new Redis(REDIS_URL, {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 0,
  // Try a few times at startup (covers a Redis that's slow to come up), then stop so we don't
  // churn reconnect attempts forever against a host that simply isn't there.
  retryStrategy: (times) => (times <= 5 ? 1000 : null),
});

let ready = false;
let warnedUnavailable = false;

client.on('ready', () => {
  ready = true;
  warnedUnavailable = false;
  console.log('[redis] connected — cache/presence/ads pacing active');
});
client.on('end', () => { ready = false; });
client.on('error', (err) => {
  ready = false;
  if (!warnedUnavailable) {
    warnedUnavailable = true;
    console.warn(`[redis] unavailable — running without Redis (live presence + ads pacing degraded): ${err.message}. Suppressing further redis errors until it reconnects.`);
  }
});

// Kick off the lazy connection; failures are handled by the 'error' listener above.
client.connect().catch(() => {});

// Per-command fallback when Redis isn't ready, shaped so existing callers keep working:
// list reads must be iterable, hash reads must be objects, everything else reads as a miss.
const ARRAY_REPLY = new Set(['smembers', 'zrange', 'zrevrange', 'lrange', 'keys', 'hkeys', 'hvals', 'sort', 'spop']);
const OBJECT_REPLY = new Set(['hgetall']);
function fallbackFor(method) {
  if (ARRAY_REPLY.has(method)) return [];
  if (OBJECT_REPLY.has(method)) return {};
  return null; // get/exists/incr/set/sadd/expire/del/... → "no value" / "no-op"
}

// Event + lifecycle methods pass straight through to the real client.
const PASSTHROUGH = new Set(['on', 'once', 'off', 'removeListener', 'addListener', 'emit', 'connect', 'disconnect', 'quit']);

const redis = new Proxy(client, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver);
    if (typeof value !== 'function') return value;           // .status, .options, etc.
    if (typeof prop !== 'string' || PASSTHROUGH.has(prop)) {
      return value.bind(target);
    }
    // Data command: only issue it when connected, otherwise resolve a safe default silently.
    return (...args) => {
      if (!ready) return Promise.resolve(fallbackFor(prop));
      try {
        return Promise.resolve(value.apply(target, args)).catch(() => fallbackFor(prop));
      } catch {
        return Promise.resolve(fallbackFor(prop));
      }
    };
  },
});

// Lets callers distinguish "Redis is up and this SET NX genuinely lost the lock" (→ 429) from
// "Redis is unavailable so the command was a no-op that also returned null" (→ proceed without the
// lock). Without this, every redis.set(...,'NX') lock reads as "already held" on a Redis-less prod
// and the guarded route 429s for everyone (broke chunked video finalize + channel subscribe).
export function isRedisReady() {
  return ready;
}

export default redis;
