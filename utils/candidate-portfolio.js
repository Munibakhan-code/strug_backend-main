/**
 * Jobs Phase 4 — seeker portfolio gallery helpers.
 */

export const PORTFOLIO_MEDIA_TYPES = new Set(['image', 'pdf', 'link', 'video']);
export const MAX_PORTFOLIO_ITEMS = 24;
export const MAX_TITLE_LEN = 120;
export const MAX_URL_LEN = 2048;

export function isSafeHttpUrl(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > MAX_URL_LEN) return false;
  try {
    const u = new URL(text);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function normalizePortfolioMediaType(raw, url = '') {
  const t = String(raw ?? '').trim().toLowerCase();
  if (PORTFOLIO_MEDIA_TYPES.has(t)) return t;
  const lower = String(url ?? '').toLowerCase();
  if (/\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(lower)) return 'image';
  if (/\.pdf(\?|$)/i.test(lower)) return 'pdf';
  if (/\.(mp4|webm|mov)(\?|$)/i.test(lower)) return 'video';
  return 'link';
}

/**
 * @param {object} input
 * @returns {{ ok: true, item: object } | { ok: false, error: string }}
 */
export function normalizePortfolioItemInput(input = {}) {
  const title = String(input.title ?? '').trim().slice(0, MAX_TITLE_LEN);
  const url = String(input.url ?? '').trim();
  if (!isSafeHttpUrl(url)) {
    return { ok: false, error: 'Portfolio URL must be a valid http(s) link.' };
  }
  const media_type = normalizePortfolioMediaType(input.media_type, url);
  let sort_order = 0;
  if (input.sort_order != null && input.sort_order !== '') {
    const n = Number(input.sort_order);
    if (!Number.isFinite(n) || n < 0 || n > 9999) {
      return { ok: false, error: 'sort_order must be a number between 0 and 9999.' };
    }
    sort_order = Math.floor(n);
  }
  return {
    ok: true,
    item: {
      title: title || null,
      url,
      media_type,
      sort_order,
    },
  };
}

/** Public shape for talent-pool / self portfolio responses. */
export function serializePortfolioItem(row) {
  if (!row) return null;
  return {
    portfolio_item_id: row.portfolio_item_id,
    candidate_id: row.candidate_id,
    title: row.title ?? null,
    url: row.url,
    media_type: row.media_type ?? 'link',
    sort_order: row.sort_order ?? 0,
    created_at: row.created_at ?? null,
  };
}
