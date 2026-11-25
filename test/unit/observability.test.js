import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Two things are being protected here:
//   1. Nothing secret ever leaves the process in a crash report.
//   2. Client-caused 4xx traffic (validation, auth, not-found) is NOT reported — otherwise the
//      genuine crashes are buried under normal traffic and the alerting is worthless.

const sentryMock = vi.hoisted(() => ({
  init: vi.fn(),
  flush: vi.fn(() => Promise.resolve(true)),
  captureException: vi.fn(),
  withScope: vi.fn((fn) => fn({ setTag: vi.fn(), setUser: vi.fn(), setExtras: vi.fn() })),
}));

vi.mock('@sentry/node', () => sentryMock);
vi.mock('../../utils/logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const ORIGINAL_DSN = process.env.SENTRY_DSN;

async function loadFresh(dsn) {
  vi.resetModules();
  vi.clearAllMocks();
  if (dsn) process.env.SENTRY_DSN = dsn;
  else delete process.env.SENTRY_DSN;
  return import('../../utils/observability.js');
}

afterEach(() => {
  if (ORIGINAL_DSN === undefined) delete process.env.SENTRY_DSN;
  else process.env.SENTRY_DSN = ORIGINAL_DSN;
});

describe('observability — inert without a DSN', () => {
  it('does not initialise and never calls the SDK', async () => {
    const obs = await loadFresh(null);
    expect(obs.initObservability()).toBe(false);
    expect(obs.isObservabilityEnabled()).toBe(false);
    expect(sentryMock.init).not.toHaveBeenCalled();

    obs.captureError(new Error('boom'), { correlationId: 'abc' });
    expect(sentryMock.captureException).not.toHaveBeenCalled();

    await expect(obs.flushObservability()).resolves.toBe(true);
    expect(sentryMock.flush).not.toHaveBeenCalled();
  });
});

describe('observability — enabled', () => {
  const DSN = 'https://key@o0.ingest.sentry.io/0';

  it('initialises with PII off and tracing off by default', async () => {
    const obs = await loadFresh(DSN);
    expect(obs.initObservability()).toBe(true);
    const config = sentryMock.init.mock.calls[0][0];
    expect(config.sendDefaultPii).toBe(false);
    expect(config.tracesSampleRate).toBe(0);
  });

  it('survives an SDK init failure instead of taking down boot', async () => {
    const obs = await loadFresh(DSN);
    sentryMock.init.mockImplementationOnce(() => { throw new Error('bad dsn'); });
    expect(obs.initObservability()).toBe(false);
    expect(obs.isObservabilityEnabled()).toBe(false);
  });

  it('captureError never throws, even on a hostile context', async () => {
    const obs = await loadFresh(DSN);
    obs.initObservability();
    const hostile = {};
    Object.defineProperty(hostile, 'boom', { get() { throw new Error('nope'); }, enumerable: true });
    expect(() => obs.captureError(new Error('x'), hostile)).not.toThrow();
  });

  describe('beforeSend scrubbing', () => {
    async function beforeSend() {
      const obs = await loadFresh(DSN);
      obs.initObservability();
      return sentryMock.init.mock.calls[0][0].beforeSend;
    }

    it('redacts auth headers and cookies', async () => {
      const send = await beforeSend();
      const event = send({
        request: {
          headers: { authorization: 'Bearer real.jwt.here', 'x-api-key': 'sk_live_1', 'x-trace': 'keep' },
          cookies: 'refresh_token=abc',
        },
      });
      expect(event.request.headers.authorization).toBe('[redacted]');
      expect(event.request.headers['x-api-key']).toBe('[redacted]');
      expect(event.request.headers['x-trace']).toBe('keep');
      expect(event.request.cookies).toBe('[redacted]');
      expect(JSON.stringify(event)).not.toMatch(/real\.jwt\.here|sk_live_1/);
    });

    it('redacts payment, OTP and credential fields nested in the request body', async () => {
      const send = await beforeSend();
      const event = send({
        request: {
          data: {
            user: { password: 'hunter2', name: 'keep' },
            payment: { card_number: '4242424242424242', cvv: '123' },
            otp_code: '9999',
          },
        },
      });
      const body = JSON.stringify(event);
      expect(body).not.toMatch(/hunter2|4242424242424242|123"|9999/);
      expect(event.request.data.user.name).toBe('keep');
    });

    it('reduces the user object to an id', async () => {
      const send = await beforeSend();
      const event = send({ user: { id: 9, email: 'a@b.com', ip_address: '1.2.3.4' } });
      expect(event.user).toEqual({ id: 9 });
    });

    it('drops the event when scrubbing itself fails', async () => {
      const send = await beforeSend();
      const hostile = { request: {} };
      Object.defineProperty(hostile.request, 'headers', {
        get() { throw new Error('nope'); }, enumerable: true,
      });
      expect(send(hostile)).toBeNull();
    });
  });
});

describe('globalErrorHandler — what gets reported', () => {
  let captureErrorMock;

  beforeEach(async () => {
    vi.resetModules();
    captureErrorMock = vi.fn();
    vi.doMock('../../utils/observability.js', () => ({
      captureError: captureErrorMock,
      isObservabilityEnabled: () => true,
      initObservability: () => true,
      flushObservability: () => Promise.resolve(true),
    }));
  });

  async function handle(err) {
    const { globalErrorHandler } = await import('../../middleware/error-handler.js');
    const req = { originalUrl: '/x', method: 'POST', correlationId: 'cid-1', user: { user_id: 5 } };
    const res = { status: vi.fn(() => res), json: vi.fn(() => res) };
    globalErrorHandler(err, req, res, vi.fn());
    return res;
  }

  it('reports a plain unexpected error', async () => {
    await handle(new Error('kaboom'));
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    expect(captureErrorMock.mock.calls[0][1]).toMatchObject({
      correlationId: 'cid-1', userId: 5, path: '/x', method: 'POST',
    });
  });

  it('reports a Prisma engine failure (P1xxx) — that is an outage, not a client mistake', async () => {
    const err = Object.assign(new Error('cannot reach db'), { code: 'P1001' });
    await handle(err);
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT report a Zod validation failure', async () => {
    const { ZodError } = await import('zod');
    await handle(new ZodError([]));
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  it.each([
    ['P2002 duplicate', { code: 'P2002', meta: { target: ['email'] } }],
    ['P2025 not found', { code: 'P2025' }],
    ['P2003 bad FK', { code: 'P2003' }],
  ])('does NOT report a client-caused Prisma error: %s', async (_label, props) => {
    await handle(Object.assign(new Error('client'), props));
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  it('does NOT report an expired or malformed JWT', async () => {
    await handle(Object.assign(new Error('jwt expired'), { name: 'TokenExpiredError' }));
    await handle(Object.assign(new Error('bad jwt'), { name: 'JsonWebTokenError' }));
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  it('does NOT report an oversized upload', async () => {
    await handle(Object.assign(new Error('too big'), { code: 'LIMIT_FILE_SIZE' }));
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  it('does NOT report an explicit 4xx, but DOES report an explicit 5xx', async () => {
    await handle(Object.assign(new Error('forbidden'), { status: 403 }));
    expect(captureErrorMock).not.toHaveBeenCalled();

    await handle(Object.assign(new Error('upstream down'), { status: 502 }));
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
  });
});
