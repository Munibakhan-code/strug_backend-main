import crypto from 'crypto';

const B62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Non-sequential, URL-safe public identifier for shareable links
 * (/v/{public_id}-{slug}). Crypto-random base62 — does not expose the sequential
 * primary key. 8 chars ≈ 2.18e14 space, so collisions are astronomically rare
 * (and creates retry on the unique constraint anyway).
 */
export function genPublicId(len = 8) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += B62[bytes[i] % 62];
  return out;
}

/**
 * Slugify a title into the decorative part of the canonical URL.
 * lowercase → strip diacritics → non-alphanumerics to '-' → trim → cap 80.
 * Mirrors the SQL backfill in migration 20260613 (exact parity is cosmetic since
 * identity is public_id). Blank/empty titles fall back to 'video'.
 */
export function slugify(title, max = 80) {
  const s = String(title ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s || 'video';
}
