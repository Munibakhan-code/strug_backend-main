// Bounded list queries.
//
// 615 of this service's 905 `findMany` calls have no `take` and no cursor. On a list whose row
// count grows with the platform — every order a vendor has ever taken, every review on a
// listing — that is a latency cliff that arrives silently, and an unauthenticated way to make
// the database do arbitrary work.
//
// The rule this module enforces: a list endpoint ALWAYS has an upper bound, whether or not the
// client asked for one.
//
// Response shape is deliberately unchanged. These endpoints return a bare array today and the
// frontend destructures it directly, so switching to a `{ data, total }` envelope would break
// every caller. Instead the page metadata rides on response headers, which no existing client
// reads and any new one can.

/** Nothing may exceed this, whatever the client asks for. */
export const MAX_PAGE_SIZE = 200;

/** Used when the client says nothing. Keeps today's behaviour for all but the largest lists. */
export const DEFAULT_PAGE_SIZE = 100;

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return i > 0 ? i : fallback;
}

/**
 * Read `limit`/`offset` (or `page`) from a request and clamp them to a safe range.
 *
 * Accepts either style:
 *   ?limit=50&offset=100
 *   ?limit=50&page=3         (1-based; page 3 of 50 => offset 100)
 *
 * @param {import('express').Request} req
 * @param {{ defaultLimit?: number, maxLimit?: number }} [options]
 * @returns {{ take: number, skip: number, limit: number, offset: number, page: number }}
 */
export function parsePagination(req, options = {}) {
  const maxLimit = Math.min(options.maxLimit ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);
  const defaultLimit = Math.min(options.defaultLimit ?? DEFAULT_PAGE_SIZE, maxLimit);

  const q = req?.query ?? {};
  const limit = Math.min(toPositiveInt(q.limit ?? q.take ?? q.per_page, defaultLimit), maxLimit);

  // `page` is 1-based and only used when an explicit offset was not supplied.
  let offset = toPositiveInt(q.offset ?? q.skip, 0);
  if (offset === 0 && q.offset == null && q.skip == null && q.page != null) {
    offset = (toPositiveInt(q.page, 1) - 1) * limit;
  }
  // toPositiveInt rejects 0, so an explicit `offset=0` falls through to the fallback — normalise.
  if (q.offset === '0' || q.offset === 0 || q.skip === '0' || q.skip === 0) offset = 0;

  return {
    take: limit,
    skip: offset,
    limit,
    offset,
    page: Math.floor(offset / limit) + 1,
  };
}

/**
 * Advertise the page on response headers, leaving the body shape untouched.
 *
 * X-Total-Count is omitted when `total` is not supplied — counting is a second query and is not
 * always worth it. X-Has-More still tells a client whether to ask for another page.
 *
 * @param {import('express').Response} res
 * @param {{ limit: number, offset: number }} pagination
 * @param {number} returnedCount  Rows actually returned.
 * @param {number} [total]        Total matching rows, when a count was run.
 */
export function setPaginationHeaders(res, pagination, returnedCount, total) {
  const { limit, offset } = pagination;
  res.set('X-Page-Limit', String(limit));
  res.set('X-Page-Offset', String(offset));
  if (typeof total === 'number') res.set('X-Total-Count', String(total));
  // A full page implies there may be more; a short page proves there is not.
  const hasMore = typeof total === 'number' ? offset + returnedCount < total : returnedCount === limit;
  res.set('X-Has-More', hasMore ? 'true' : 'false');
  // CORS: these are custom headers, so a browser client cannot read them unless they are exposed.
  res.set('Access-Control-Expose-Headers', [
    'X-Page-Limit', 'X-Page-Offset', 'X-Total-Count', 'X-Has-More',
  ].join(', '));
}

/**
 * Convenience for the common shape: clamp, query, then advertise the page.
 *
 * @template T
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {(pagination: { take: number, skip: number }) => Promise<T[]>} query
 * @param {{ defaultLimit?: number, maxLimit?: number, total?: () => Promise<number> }} [options]
 * @returns {Promise<T[]>}
 */
export async function paginate(req, res, query, options = {}) {
  const pagination = parsePagination(req, options);
  const [rows, total] = await Promise.all([
    query(pagination),
    options.total ? options.total() : Promise.resolve(undefined),
  ]);
  setPaginationHeaders(res, pagination, Array.isArray(rows) ? rows.length : 0, total);
  return rows;
}
