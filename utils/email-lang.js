import i18next from './i18n.js';

const SUPPORTED = new Set(
  (i18next.options?.supportedLngs || ['en']).filter((l) => l !== 'cimode'),
);

/** Map app locale codes to backend locale folder names. */
const LANG_ALIASES = { tl: 'fil' };

/**
 * Normalize a language code for email i18n (falls back to en).
 * @param {string} [code]
 * @param {string} [fallback='en']
 */
export function resolveEmailLng(code, fallback = 'en') {
  if (!code) return fallback;
  const base = String(code).split('-')[0].toLowerCase();
  const mapped = LANG_ALIASES[base] || base;
  if (SUPPORTED.has(mapped)) return mapped;
  return fallback;
}

/**
 * @param {{ language?: string } | null | undefined} user
 * @param {string} [fallback='en']
 */
export function emailLngFromUser(user, fallback = 'en') {
  return resolveEmailLng(user?.language, fallback);
}

/**
 * @param {import('express').Request} [req]
 * @param {string} [fallback='en']
 */
export function emailLngFromRequest(req, fallback = 'en') {
  const hdr = req?.headers?.['accept-language'];
  if (!hdr) return fallback;
  const first = String(hdr).split(',')[0].trim().split('-')[0];
  return resolveEmailLng(first, fallback);
}

/**
 * Login alert: DB language first, then client preference header (localStorage), then Accept-Language.
 * @param {{ language?: string } | null | undefined} user
 * @param {import('express').Request} [req]
 */
export function resolveLoginEmailLng(user, req, fallback = 'en') {
  const client = req?.headers?.['x-strug-language'] || req?.body?.language;
  if (client) return resolveEmailLng(String(client).trim(), fallback);
  if (user?.language) return emailLngFromUser(user, fallback);
  return emailLngFromRequest(req, fallback);
}
