import { describe, it, expect, vi } from 'vitest';
import {
  parsePagination,
  setPaginationHeaders,
  paginate,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
} from '../../utils/pagination.js';

const reqWith = (query) => ({ query });
const fakeRes = () => {
  const headers = {};
  return { headers, set: vi.fn((k, v) => { headers[k] = v; }) };
};

describe('parsePagination — clamping', () => {
  it('defaults to DEFAULT_PAGE_SIZE when the client says nothing', () => {
    expect(parsePagination(reqWith({}))).toMatchObject({
      take: DEFAULT_PAGE_SIZE, skip: 0, page: 1,
    });
  });

  it('never exceeds MAX_PAGE_SIZE, however large the request', () => {
    for (const limit of ['1000', '999999', String(Number.MAX_SAFE_INTEGER)]) {
      expect(parsePagination(reqWith({ limit })).take).toBe(MAX_PAGE_SIZE);
    }
  });

  it('honours a per-endpoint maxLimit below the global cap', () => {
    expect(parsePagination(reqWith({ limit: '500' }), { maxLimit: 25 }).take).toBe(25);
  });

  it('cannot be raised above the global cap by a caller option', () => {
    expect(parsePagination(reqWith({ limit: '9999' }), { maxLimit: 100000 }).take).toBe(MAX_PAGE_SIZE);
  });

  it.each([
    ['zero', '0'],
    ['negative', '-5'],
    ['garbage', 'DROP TABLE'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['empty', ''],
    ['array', ['3', '4']],
  ])('falls back to the default for a %s limit', (_label, limit) => {
    expect(parsePagination(reqWith({ limit })).take).toBe(DEFAULT_PAGE_SIZE);
  });

  it('never produces a negative skip', () => {
    expect(parsePagination(reqWith({ offset: '-100' })).skip).toBe(0);
  });

  it('truncates a fractional limit rather than passing it to Prisma', () => {
    const { take } = parsePagination(reqWith({ limit: '10.9' }));
    expect(Number.isInteger(take)).toBe(true);
    expect(take).toBe(10);
  });
});

describe('parsePagination — offset and page', () => {
  it('reads an explicit offset', () => {
    expect(parsePagination(reqWith({ limit: '20', offset: '40' }))).toMatchObject({ skip: 40, page: 3 });
  });

  it('accepts an explicit offset of 0', () => {
    expect(parsePagination(reqWith({ offset: '0' })).skip).toBe(0);
  });

  it('derives the offset from a 1-based page', () => {
    expect(parsePagination(reqWith({ limit: '50', page: '3' })).skip).toBe(100);
  });

  it('treats page 1 as offset 0', () => {
    expect(parsePagination(reqWith({ limit: '50', page: '1' })).skip).toBe(0);
  });

  it('prefers an explicit offset over page', () => {
    expect(parsePagination(reqWith({ limit: '10', offset: '5', page: '9' })).skip).toBe(5);
  });

  it('accepts the take/skip aliases', () => {
    expect(parsePagination(reqWith({ take: '15', skip: '30' }))).toMatchObject({ take: 15, skip: 30 });
  });

  it('survives a request with no query object at all', () => {
    expect(parsePagination({})).toMatchObject({ take: DEFAULT_PAGE_SIZE, skip: 0 });
    expect(parsePagination(undefined)).toMatchObject({ take: DEFAULT_PAGE_SIZE, skip: 0 });
  });
});

describe('setPaginationHeaders', () => {
  it('reports limit, offset and total', () => {
    const res = fakeRes();
    setPaginationHeaders(res, { limit: 20, offset: 40 }, 20, 500);
    expect(res.headers['X-Page-Limit']).toBe('20');
    expect(res.headers['X-Page-Offset']).toBe('40');
    expect(res.headers['X-Total-Count']).toBe('500');
    expect(res.headers['X-Has-More']).toBe('true');
  });

  it('omits X-Total-Count when no count was run', () => {
    const res = fakeRes();
    setPaginationHeaders(res, { limit: 20, offset: 0 }, 20);
    expect(res.headers['X-Total-Count']).toBeUndefined();
    // A full page still signals "there may be more".
    expect(res.headers['X-Has-More']).toBe('true');
  });

  it('reports no more when the page is short', () => {
    const res = fakeRes();
    setPaginationHeaders(res, { limit: 20, offset: 0 }, 7);
    expect(res.headers['X-Has-More']).toBe('false');
  });

  it('reports no more on an exactly-full final page when total is known', () => {
    const res = fakeRes();
    setPaginationHeaders(res, { limit: 20, offset: 80 }, 20, 100);
    expect(res.headers['X-Has-More']).toBe('false');
  });

  it('exposes the headers to browser clients via CORS', () => {
    const res = fakeRes();
    setPaginationHeaders(res, { limit: 10, offset: 0 }, 10, 10);
    expect(res.headers['Access-Control-Expose-Headers']).toContain('X-Total-Count');
    expect(res.headers['Access-Control-Expose-Headers']).toContain('X-Has-More');
  });
});

describe('paginate', () => {
  it('hands the clamped take/skip to the query', async () => {
    const res = fakeRes();
    const query = vi.fn(async () => []);
    await paginate(reqWith({ limit: '5000', offset: '10' }), res, query);
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ take: MAX_PAGE_SIZE, skip: 10 }));
  });

  it('returns the rows unchanged — the response body shape must not move', async () => {
    const rows = [{ id: 1 }, { id: 2 }];
    const out = await paginate(reqWith({}), fakeRes(), async () => rows);
    expect(out).toBe(rows);
    expect(Array.isArray(out)).toBe(true);
  });

  it('runs the count alongside the query and reports it', async () => {
    const res = fakeRes();
    await paginate(reqWith({ limit: '2' }), res, async () => [1, 2], { total: async () => 97 });
    expect(res.headers['X-Total-Count']).toBe('97');
    expect(res.headers['X-Has-More']).toBe('true');
  });

  it('propagates a query failure instead of swallowing it', async () => {
    await expect(
      paginate(reqWith({}), fakeRes(), async () => { throw new Error('db down'); }),
    ).rejects.toThrow('db down');
  });
});
