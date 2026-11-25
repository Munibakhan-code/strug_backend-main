import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// Probes must answer correctly with no database available, so prisma/redis are stubbed here
// and this stays a unit test — the whole point of a liveness probe is that it still responds
// when the dependencies are down.

const prismaMock = vi.hoisted(() => ({ $queryRaw: vi.fn() }));
const redisMock = vi.hoisted(() => ({ status: 'ready', ping: vi.fn() }));

vi.mock('../../utils/prisma-client.js', () => ({ default: prismaMock }));
vi.mock('../../utils/redis-client.js', () => ({
  default: redisMock,
  isRedisReady: () => redisMock.status === 'ready',
}));
vi.mock('../../utils/logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const { default: healthRouter } = await import('../../routes/health-routes.js');

function makeApp() {
  const app = express();
  app.use('/health', healthRouter);
  return app;
}

describe('health probes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    redisMock.status = 'ready';
    redisMock.ping.mockResolvedValue('PONG');
  });

  describe('GET /health (liveness)', () => {
    it('returns 200 without touching any dependency', async () => {
      const res = await request(makeApp()).get('/health').expect(200);
      expect(res.body.status).toBe('ok');
      expect(typeof res.body.uptime_s).toBe('number');
      // Liveness must not perform I/O — a dependency outage should never kill the replica.
      expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
      expect(redisMock.ping).not.toHaveBeenCalled();
    });

    it('still returns 200 when the database is unreachable', async () => {
      prismaMock.$queryRaw.mockRejectedValue(new Error('ECONNREFUSED'));
      await request(makeApp()).get('/health').expect(200);
    });
  });

  describe('GET /health/ready (readiness)', () => {
    it('returns 200 with both checks true when everything is up', async () => {
      const res = await request(makeApp()).get('/health/ready').expect(200);
      expect(res.body).toMatchObject({ status: 'ok', checks: { database: true, redis: true } });
      expect(prismaMock.$queryRaw).toHaveBeenCalled();
    });

    it('returns 503 when Postgres is unreachable', async () => {
      prismaMock.$queryRaw.mockRejectedValue(new Error('ECONNREFUSED'));
      const res = await request(makeApp()).get('/health/ready').expect(503);
      expect(res.body.status).toBe('unavailable');
      expect(res.body.checks.database).toBe(false);
    });

    it('stays ready when only Redis is down — the limiter and caches fall back in-memory', async () => {
      redisMock.status = 'end';
      const res = await request(makeApp()).get('/health/ready').expect(200);
      expect(res.body.checks).toEqual({ database: true, redis: false });
    });

    it('never leaks dependency error detail into the response body', async () => {
      prismaMock.$queryRaw.mockRejectedValue(new Error('postgres://user:hunter2@db:5432 refused'));
      const res = await request(makeApp()).get('/health/ready').expect(503);
      const body = JSON.stringify(res.body);
      expect(body).not.toMatch(/hunter2|postgres:\/\//);
      expect(res.body._errors).toBeUndefined();
    });

    it('fails readiness rather than hanging when a check never settles', async () => {
      // A probe that hangs is worse than one that fails: the orchestrator's own timeout fires
      // and recycles a replica that was merely slow.
      prismaMock.$queryRaw.mockReturnValue(new Promise(() => {}));
      const res = await request(makeApp()).get('/health/ready').expect(503);
      expect(res.body.checks.database).toBe(false);
    }, 10000);
  });

  describe('GET /health/startup', () => {
    it('reports the same signal as readiness', async () => {
      const res = await request(makeApp()).get('/health/startup').expect(200);
      expect(res.body.checks.database).toBe(true);
    });
  });
});
