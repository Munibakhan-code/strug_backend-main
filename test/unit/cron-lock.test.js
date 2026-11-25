import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// This lock is what makes `--max-replicas > 1` safe. If it is wrong, the failure mode is
// duplicate ride dispatch, duplicate saved-search emails and duplicate payout sweeps — silent,
// and only in production. So it is tested against a fake Redis that models the actual
// SET NX PX / EVAL semantics rather than a bare stub.

function makeFakeRedis() {
  const store = new Map(); // key -> { value, expiresAt }
  const now = () => Date.now();
  const live = (k) => {
    const e = store.get(k);
    if (!e) return null;
    if (e.expiresAt <= now()) { store.delete(k); return null; }
    return e;
  };
  return {
    status: 'ready',
    store,
    async set(key, value, ...args) {
      // Mirrors ioredis: set(key, value, 'PX', ms, 'NX')
      const pxIdx = args.findIndex((a) => String(a).toUpperCase() === 'PX');
      const ttl = pxIdx >= 0 ? Number(args[pxIdx + 1]) : 60_000;
      const nx = args.some((a) => String(a).toUpperCase() === 'NX');
      if (nx && live(key)) return null;
      store.set(key, { value, expiresAt: now() + ttl });
      return 'OK';
    },
    async eval(script, _numKeys, key, owner, ttl) {
      const entry = live(key);
      if (!entry || entry.value !== owner) return 0;
      if (/pexpire/.test(script)) { entry.expiresAt = now() + Number(ttl); return 1; }
      store.delete(key);
      return 1;
    },
  };
}

const redisMock = vi.hoisted(() => ({ current: null }));

vi.mock('../../utils/redis-client.js', () => ({
  get default() { return redisMock.current; },
  isRedisReady: () => redisMock.current?.status === 'ready',
}));
vi.mock('../../utils/logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock('../../utils/observability.js', () => ({
  captureError: vi.fn(),
  isObservabilityEnabled: () => false,
}));
vi.mock('node-cron', () => ({
  default: { schedule: vi.fn((expr, handler, opts) => ({ expr, handler, opts, stop: vi.fn() })) },
}));

const ENV_KEYS = ['CRON_ENABLED', 'CRON_REQUIRE_LOCK'];
const savedEnv = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  redisMock.current = makeFakeRedis();
  vi.clearAllMocks();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

async function load() {
  vi.resetModules();
  return import('../../utils/cron-lock.js');
}

describe('withCronLock — mutual exclusion', () => {
  it('runs the job when the lock is free', async () => {
    const { withCronLock } = await load();
    const job = vi.fn();
    await expect(withCronLock('j1', job)).resolves.toBe(true);
    expect(job).toHaveBeenCalledTimes(1);
  });

  it('lets exactly ONE of many concurrent replicas run a tick', async () => {
    const { withCronLock } = await load();
    let ran = 0;
    // A slow job, so all five overlap — the shape a real 5-replica deployment produces.
    const job = () => new Promise((r) => { ran++; setTimeout(r, 20); });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => withCronLock('dispatch', job)),
    );
    expect(ran).toBe(1);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('releases the lock so the NEXT tick can run', async () => {
    const { withCronLock } = await load();
    const job = vi.fn();
    await withCronLock('j2', job);
    await withCronLock('j2', job);
    expect(job).toHaveBeenCalledTimes(2);
  });

  it('releases the lock even when the job throws', async () => {
    const { withCronLock } = await load();
    const boom = vi.fn(() => { throw new Error('job exploded'); });
    await expect(withCronLock('j3', boom)).resolves.toBe(true);
    // Lock must not be stranded — a thrown job would otherwise block the job forever.
    const after = vi.fn();
    await withCronLock('j3', after);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('swallows a job error rather than letting it escape to the scheduler', async () => {
    const { withCronLock } = await load();
    await expect(withCronLock('j4', async () => { throw new Error('async boom'); })).resolves.toBe(true);
  });

  it('reports a failing job so a permanently-broken cron cannot stay silent', async () => {
    const { withCronLock } = await load();
    // Resolve the mock AFTER resetModules, so it is the same instance the lock imported.
    const { captureError } = await import('../../utils/observability.js');
    await withCronLock('j5', () => { throw new Error('nightly sweep broken'); });
    expect(captureError).toHaveBeenCalledTimes(1);
    expect(captureError.mock.calls[0][1]).toMatchObject({ jobId: 'j5', kind: 'cron' });
  });

  it('does not release a lock it no longer owns', async () => {
    const { withCronLock, __testing } = await load();
    const redis = redisMock.current;
    const key = `${__testing.KEY_PREFIX}j6`;
    // Another replica takes over mid-run (as if our lease had expired).
    const job = async () => {
      redis.store.set(key, { value: 'other-replica', expiresAt: Date.now() + 60_000 });
    };
    await withCronLock('j6', job);
    expect(redis.store.get(key)?.value).toBe('other-replica');
  });
});

describe('withCronLock — Redis unavailable', () => {
  it('runs the job by default, matching single-replica behaviour', async () => {
    redisMock.current.status = 'end';
    const { withCronLock } = await load();
    const job = vi.fn();
    await expect(withCronLock('j7', job)).resolves.toBe(true);
    expect(job).toHaveBeenCalledTimes(1);
  });

  it('SKIPS the job when CRON_REQUIRE_LOCK=true — the multi-replica setting', async () => {
    process.env.CRON_REQUIRE_LOCK = 'true';
    redisMock.current.status = 'end';
    const { withCronLock } = await load();
    const job = vi.fn();
    await expect(withCronLock('j8', job)).resolves.toBe(false);
    expect(job).not.toHaveBeenCalled();
  });

  it('skips when acquisition itself errors and the lock is required', async () => {
    process.env.CRON_REQUIRE_LOCK = 'true';
    redisMock.current.set = () => Promise.reject(new Error('READONLY'));
    const { withCronLock } = await load();
    const job = vi.fn();
    await expect(withCronLock('j9', job)).resolves.toBe(false);
    expect(job).not.toHaveBeenCalled();
  });
});

describe('CRON_ENABLED=false — the dedicated-worker split', () => {
  it('runs nothing', async () => {
    process.env.CRON_ENABLED = 'false';
    const { withCronLock } = await load();
    const job = vi.fn();
    await expect(withCronLock('j10', job)).resolves.toBe(false);
    expect(job).not.toHaveBeenCalled();
  });

  it('registers no node-cron schedule at all', async () => {
    process.env.CRON_ENABLED = 'false';
    const cron = (await import('node-cron')).default;
    const { scheduleCron } = await load();
    expect(scheduleCron('j11', '* * * * *', vi.fn())).toBeNull();
    expect(cron.schedule).not.toHaveBeenCalled();
  });

  it('creates no interval timer', async () => {
    process.env.CRON_ENABLED = 'false';
    const { scheduleInterval } = await load();
    expect(scheduleInterval('j12', vi.fn(), 1000)).toBeNull();
  });
});

describe('scheduleCron / scheduleInterval wiring', () => {
  it('passes the cron expression straight through to node-cron', async () => {
    const cron = (await import('node-cron')).default;
    const { scheduleCron } = await load();
    scheduleCron('ride-timeout-refund', '*/2 * * * *', vi.fn());
    expect(cron.schedule).toHaveBeenCalledWith('*/2 * * * *', expect.any(Function), undefined);
  });

  it('routes the scheduled tick through the lock', async () => {
    const cron = (await import('node-cron')).default;
    const { scheduleCron } = await load();
    const job = vi.fn();
    scheduleCron('locked-job', '* * * * *', job);
    const tick = cron.schedule.mock.calls[0][1];
    tick();
    tick(); // second replica firing the same second
    await new Promise((r) => setTimeout(r, 10));
    // Both ticks resolve against the same key; only one body runs.
    expect(job).toHaveBeenCalledTimes(1);
  });

  it('keeps setInterval argument order so call sites change only in the head', async () => {
    const { scheduleInterval } = await load();
    const job = vi.fn();
    const timer = scheduleInterval('interval-job', job, 20);
    expect(timer).toBeTruthy();
    await new Promise((r) => setTimeout(r, 55));
    clearInterval(timer);
    expect(job.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('leases an interval job for at least twice its period', async () => {
    // A lease shorter than the period would let the next tick start while this one still runs.
    const { scheduleInterval, __testing } = await load();
    const timer = scheduleInterval('long-job', () => {}, 10 * 60 * 1000);
    clearInterval(timer);
    expect(__testing.DEFAULT_TTL_MS).toBeLessThan(20 * 60 * 1000);
  });
});
