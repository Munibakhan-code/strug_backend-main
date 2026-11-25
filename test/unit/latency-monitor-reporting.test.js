import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// 1,540 route handlers in this service catch their own error and answer `res.status(500)`
// directly. Those failures never reach globalErrorHandler, so before this they were reported
// nowhere: a route could 500 on every single call for months (as two of them did) and produce
// no alert at all. latencyMonitor now watches the finished response instead of relying on the
// handler routing its error anywhere in particular.

const captureErrorMock = vi.hoisted(() => vi.fn());
const loggerMock = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), log: vi.fn() }));

vi.mock('../../utils/observability.js', () => ({
  captureError: captureErrorMock,
  isObservabilityEnabled: () => true,
}));
vi.mock('../../utils/logger.js', () => ({ default: loggerMock }));

const { latencyMonitor } = await import('../../middleware/latency-monitor.js');
const { noteRequestError } = await import('../../utils/request-context.js');

function appWith(handler) {
  const app = express();
  app.use(latencyMonitor);
  app.get('/t', handler);
  return app;
}

beforeEach(() => vi.clearAllMocks());

describe('correlation id', () => {
  it('mints one and echoes it on the response', async () => {
    const res = await request(appWith((_req, r) => r.json({ ok: true }))).get('/t');
    expect(res.headers['x-correlation-id']).toMatch(/[0-9a-f-]{36}/);
  });

  it('honours an inbound X-Correlation-ID so a trace spans services', async () => {
    const res = await request(appWith((_req, r) => r.json({ ok: true })))
      .get('/t')
      .set('X-Correlation-ID', 'upstream-123');
    expect(res.headers['x-correlation-id']).toBe('upstream-123');
  });
});

describe('5xx reporting', () => {
  it('reports a route that answers 500 itself without calling next(err)', async () => {
    await request(appWith((_req, r) => r.status(500).json({ error: 'Failed to fetch orders' })))
      .get('/t')
      .expect(500);
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    expect(captureErrorMock.mock.calls[0][1]).toMatchObject({
      statusCode: 500,
      path: '/t',
      method: 'GET',
      source: 'status-only',
    });
  });

  it('attaches the real error when the handler logged one before answering', async () => {
    const boom = new Error('prisma exploded');
    await request(appWith((_req, r) => { noteRequestError(boom); r.status(500).json({ error: 'x' }); }))
      .get('/t')
      .expect(500);
    expect(captureErrorMock.mock.calls[0][0]).toBe(boom);
    expect(captureErrorMock.mock.calls[0][1]).toMatchObject({ source: 'handled-in-route' });
  });

  it('reports other 5xx codes too', async () => {
    await request(appWith((_req, r) => r.status(503).json({}))).get('/t').expect(503);
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    expect(captureErrorMock.mock.calls[0][1].statusCode).toBe(503);
  });

  it('does NOT double-report when globalErrorHandler already reported it', async () => {
    const app = express();
    app.use(latencyMonitor);
    app.get('/t', (req, r) => { req.reportedByErrorHandler = true; r.status(500).json({}); });
    await request(app).get('/t').expect(500);
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  it.each([200, 201, 204, 301, 400, 401, 403, 404, 409, 422, 429])(
    'does NOT report a %i response',
    async (code) => {
      await request(appWith((_req, r) => r.status(code).end())).get('/t').expect(code);
      expect(captureErrorMock).not.toHaveBeenCalled();
    },
  );
});

describe('request telemetry', () => {
  it('logs method, path, status and duration for every request', async () => {
    await request(appWith((_req, r) => r.json({ ok: true }))).get('/t').expect(200);
    const entry = loggerMock.info.mock.calls.at(-1)[0];
    expect(entry).toMatchObject({ method: 'GET', path: '/t', status_code: 200 });
    expect(typeof entry.duration_ms).toBe('number');
  });

  it('does not interfere with a normal response body', async () => {
    const res = await request(appWith((_req, r) => r.json({ hello: 'world' }))).get('/t');
    expect(res.body).toEqual({ hello: 'world' });
  });
});
