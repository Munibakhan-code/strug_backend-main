// Regression suite for the "live module trusts Redis" bug class.
//
// utils/redis-client.js is a Proxy that RESOLVES a safe default for every command when Redis
// is not connected, instead of throwing. Prod has never had a managed Redis. The live module
// read those nulls as meaningful answers, which silently broke four things at once:
//
//   1. viewer counts   — SCARD -> null, so every stream reported 0 watchers
//   2. slow mode       — SET NX -> null read as "posted too recently", rejecting ALL chat
//   3. gift throttle   — SET NX -> null read as "rate limited", 429ing EVERY gift
//   4. schedule alerts — SADD no-op + SMEMBERS [] , so opt-ins vanished and nobody was notified
//
// The guard is always isRedisReady(): it is the only way to tell "the command genuinely says
// no" from "the command never ran". These tests pin that behaviour so the class cannot return.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(BE_ROOT, rel), 'utf8');

/** Source with comments stripped — the guards below assert about CODE, and the code they
 *  replaced is quoted verbatim in the comments explaining why it was wrong. */
const readCode = (rel) => read(rel)
  .split(/\r?\n/)
  .filter((line) => {
    const t = line.trim();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
  })
  .join('\n');

describe('redis client contract', () => {
  it('resolves instead of throwing when Redis is down, which is why try/catch cannot guard it', async () => {
    // Point at a port nothing listens on so the client can never become ready.
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    vi.resetModules();
    const { default: redis, isRedisReady } = await import('../../utils/redis-client.js');

    expect(isRedisReady()).toBe(false);

    // The three shapes the live module used to misread. None of them reject, so a
    // `try { ... } catch { /* redis down */ }` around them is dead code.
    await expect(redis.scard('stream:1:viewers')).resolves.toBeNull();
    await expect(redis.set('k', '1', 'PX', 1000, 'NX')).resolves.toBeNull();
    await expect(redis.smembers('live:sched:notify:1')).resolves.toEqual([]);
  });

  it('exposes pipeline as a callable even when down — so `typeof redis.pipeline` is a useless probe', async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    vi.resetModules();
    const { default: redis } = await import('../../utils/redis-client.js');

    // This is exactly the check live-session-routes and live-metrics-routes used to gate on.
    // It passes while Redis is dead, so the pipeline branch ran and threw a TypeError that the
    // surrounding catch swallowed — taking the non-pipeline fallback with it.
    expect(typeof redis.pipeline).toBe('function');
    await expect(redis.pipeline()).resolves.toBeNull();
  });
});

describe('live viewer presence', () => {
  beforeEach(() => { vi.resetModules(); });

  it('falls back to socket-room membership when Redis is unavailable', async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    const { viewerCount } = await import('../../services/live-presence.js');

    const io = makeIo({ 'stream_7': [{ id: 'a', userId: 10 }, { id: 'b', userId: 11 }] });
    await expect(viewerCount(io, 7)).resolves.toBe(2);
  });

  it('does not count the broadcaster as a viewer of their own stream', async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    const { viewerCount } = await import('../../services/live-presence.js');

    const io = makeIo({ 'stream_7': [{ id: 'a', userId: 99 }, { id: 'b', userId: 11 }] });
    await expect(viewerCount(io, 7, 99)).resolves.toBe(1);
  });

  it('counts one person with several tabs open once', async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    const { viewerCount } = await import('../../services/live-presence.js');

    const io = makeIo({ 'stream_7': [{ id: 'a', userId: 10 }, { id: 'b', userId: 10 }, { id: 'c', userId: 10 }] });
    await expect(viewerCount(io, 7)).resolves.toBe(1);
  });

  it('returns 0 for a session nobody is watching rather than null', async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    const { viewerCount } = await import('../../services/live-presence.js');
    await expect(viewerCount(makeIo({}), 7)).resolves.toBe(0);
  });

  it('batches counts per session id', async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    const { viewerCounts } = await import('../../services/live-presence.js');

    const io = makeIo({
      'stream_1': [{ id: 'a', userId: 10 }],
      'stream_2': [{ id: 'b', userId: 11 }, { id: 'c', userId: 12 }],
    });
    const counts = await viewerCounts(io, [{ session_id: 1 }, { session_id: 2 }, { session_id: 3 }]);
    expect(counts.get(1)).toBe(1);
    expect(counts.get(2)).toBe(2);
    expect(counts.get(3)).toBe(0);
  });
});

// Source-level guards. These are deliberately textual: the failure mode is a future edit
// reintroducing a bare `redis.set(..., 'NX')` in the live module, which no runtime test on the
// current code would catch.
describe('live module source guards', () => {
  const LIVE_SOURCES = [
    'index.js',
    'routes/live-coins-routes.js',
    'routes/live-session-routes.js',
    'routes/live-metrics-routes.js',
    'routes/live-community-routes.js',
    'routes/live-dashboard-routes.js',
    'services/live-notify.js',
    'services/live-category-browse.js',
  ];

  it('never treats a null from SET NX as a real rate-limit without checking isRedisReady()', () => {
    for (const rel of LIVE_SOURCES) {
      const src = readCode(rel);
      if (!src.includes("'NX'")) continue;
      expect(src, `${rel} uses SET NX but never calls isRedisReady()`).toContain('isRedisReady');
    }
  });

  it('does not gate on `typeof redis.pipeline`, which is always true', () => {
    for (const rel of LIVE_SOURCES) {
      expect(readCode(rel), `${rel} still uses the always-true pipeline probe`)
        .not.toContain('typeof redis.pipeline');
    }
  });

  it('reads viewer counts only through services/live-presence.js', () => {
    for (const rel of LIVE_SOURCES) {
      expect(readCode(rel), `${rel} reads the viewer set directly instead of using live-presence`)
        .not.toMatch(/scard\(\s*`stream:/);
    }
  });

  it('stores schedule reminder opt-ins durably, not in a Redis set', () => {
    for (const rel of ['routes/live-community-routes.js', 'services/live-notify.js']) {
      expect(readCode(rel), `${rel} still keeps reminder opt-ins in Redis`)
        .not.toContain('live:sched:notify');
    }
    expect(read('routes/live-community-routes.js')).toContain('live_schedule_reminder');
    expect(read('services/live-notify.js')).toContain('live_schedule_reminder');
  });
});

/** Minimal Socket.IO server stub exposing just the adapter surface live-presence reads. */
function makeIo(roomsSpec) {
  const sockets = new Map();
  const rooms = new Map();
  for (const [room, members] of Object.entries(roomsSpec)) {
    rooms.set(room, new Set(members.map((m) => m.id)));
    for (const m of members) sockets.set(m.id, m);
  }
  return { sockets: { adapter: { rooms }, sockets } };
}
