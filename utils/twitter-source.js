/**
 * Normalize a pasted X / Twitter profile or status URL for yt-dlp listing.
 * Town Hall import mirrors Creator Studio YouTube import: paste link → copy onto Strug.
 */

const HANDLE = /^@?([A-Za-z0-9_]{1,15})$/;
const STATUS_ID = /^\d{5,25}$/;

export function normalizeTwitterSourceUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    const err = new Error('Paste an X / Twitter profile or post URL');
    err.status = 400;
    throw err;
  }

  const bare = HANDLE.exec(trimmed);
  if (bare && !trimmed.includes('.')) {
    return `https://x.com/${bare[1]}`;
  }

  let url;
  try {
    url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
  } catch {
    const err = new Error('That does not look like an X / Twitter URL');
    err.status = 400;
    throw err;
  }

  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  if (!['x.com', 'twitter.com', 'mobile.twitter.com', 'mobile.x.com'].includes(host)) {
    const err = new Error('Only X / Twitter profile or post links are supported');
    err.status = 400;
    throw err;
  }

  const parts = url.pathname.split('/').filter(Boolean);
  if (!parts.length) {
    const err = new Error('Use a profile URL (x.com/handle) or a post link');
    err.status = 400;
    throw err;
  }

  const handle = parts[0].replace(/^@/, '');
  if (!HANDLE.test(handle) && !HANDLE.test(`@${handle}`)) {
    const err = new Error('Invalid X / Twitter handle');
    err.status = 400;
    throw err;
  }

  if (parts[1] === 'status' && parts[2] && STATUS_ID.test(parts[2])) {
    return `https://x.com/${handle}/status/${parts[2]}`;
  }

  // Strip tabs like /with_replies — profile root is what yt-dlp lists.
  return `https://x.com/${handle}`;
}

export function twitterStatusUrl(handle, statusId) {
  return `https://x.com/${String(handle || '').replace(/^@/, '')}/status/${statusId}`;
}

/** Town Hall posts are VARCHAR(280); keep media-only posts as a short placeholder. */
export function truncateTownHallContent(text, { max = 280, fallback = '' } = {}) {
  const cleaned = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return String(fallback || '').slice(0, max);
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
