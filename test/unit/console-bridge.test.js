import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The bridge sits under every console.* call in the service, so it has to be boring: it must
// never throw, never lose a message, and never change what a call site can pass.

const loggerMock = vi.hoisted(() => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() }));
vi.mock('../../utils/logger.js', () => ({ default: loggerMock }));

const { installConsoleBridge, restoreConsole, isConsoleBridged } =
  await import('../../utils/console-bridge.js');
const { runWithRequestContext, getRequestError } =
  await import('../../utils/request-context.js');

beforeEach(() => vi.clearAllMocks());
afterEach(() => restoreConsole());

const lastLog = () => loggerMock.log.mock.calls.at(-1)[0];

describe('installConsoleBridge', () => {
  it('is idempotent', () => {
    expect(installConsoleBridge()).toBe(true);
    expect(installConsoleBridge()).toBe(false);
    expect(isConsoleBridged()).toBe(true);
  });

  it('restoreConsole puts the real console back', () => {
    const before = console.log;
    installConsoleBridge();
    expect(console.log).not.toBe(before);
    restoreConsole();
    expect(console.log).toBe(before);
  });
});

describe('level mapping', () => {
  beforeEach(() => installConsoleBridge());

  it.each([
    ['log', 'info'],
    ['info', 'info'],
    ['warn', 'warn'],
    ['error', 'error'],
    ['debug', 'debug'],
    ['trace', 'debug'],
  ])('console.%s logs at %s', (method, level) => {
    console[method]('hello');
    expect(lastLog()).toMatchObject({ level, message: 'hello' });
  });
});

describe('formatting', () => {
  beforeEach(() => installConsoleBridge());

  it('joins multiple arguments the way console does', () => {
    console.error('[food]', 'attach offers failed:', 'boom');
    expect(lastLog().message).toBe('[food] attach offers failed: boom');
  });

  it('honours printf-style substitution', () => {
    console.log('vendor %s had %d orders', 'Pizzeria', 12);
    expect(lastLog().message).toBe('vendor Pizzeria had 12 orders');
  });

  it('serialises objects rather than printing [object Object]', () => {
    console.log('payload', { a: 1, b: [2, 3] });
    expect(lastLog().message).toContain('a: 1');
  });

  it('keeps an Error stack as its own field', () => {
    const err = new Error('db down');
    console.error('query failed', err);
    expect(lastLog().stack).toBe(err.stack);
  });

  it('handles being called with no arguments', () => {
    expect(() => console.log()).not.toThrow();
  });

  it('handles a circular object without throwing', () => {
    const circular = { name: 'loop' };
    circular.self = circular;
    expect(() => console.log('circular', circular)).not.toThrow();
  });
});

describe('request context enrichment', () => {
  beforeEach(() => installConsoleBridge());

  it('attaches the correlation id, user and route to a log written inside a request', () => {
    runWithRequestContext(
      { correlationId: 'cid-77', userId: 9, method: 'POST', path: '/food/orders' },
      () => console.error('order failed'),
    );
    expect(lastLog()).toMatchObject({
      correlation_id: 'cid-77',
      user_id: 9,
      method: 'POST',
      path: '/food/orders',
    });
  });

  it('omits the request fields entirely outside a request', () => {
    console.log('cron tick');
    const entry = lastLog();
    expect(entry.correlation_id).toBeUndefined();
    expect(entry.path).toBeUndefined();
  });

  it('survives an await — the context crosses the async boundary', async () => {
    await runWithRequestContext({ correlationId: 'cid-async' }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      console.warn('after await');
    });
    expect(lastLog().correlation_id).toBe('cid-async');
  });

  it('records the error so a route that answers 500 itself can still be reported', () => {
    const err = new Error('swallowed by the route');
    runWithRequestContext({ correlationId: 'cid-1' }, () => {
      console.error('failed to fetch food orders', err);
      expect(getRequestError()).toBe(err);
    });
  });

  it('only records errors from console.error, not from console.log', () => {
    runWithRequestContext({ correlationId: 'cid-2' }, () => {
      console.log('note', new Error('informational'));
      expect(getRequestError()).toBeUndefined();
    });
  });
});

describe('failure isolation', () => {
  it('falls back to the real console when the logger throws', () => {
    installConsoleBridge();
    loggerMock.log.mockImplementationOnce(() => { throw new Error('transport down'); });
    expect(() => console.error('still needs to be seen')).not.toThrow();
  });
});
